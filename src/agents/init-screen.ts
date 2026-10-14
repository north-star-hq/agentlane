import { styleText } from 'node:util';
import { cancel, intro, isCancel, log, multiselect, note, outro, taskLog } from '@clack/prompts';
import { CONFIG_FILE, TOOL } from '../name.ts';
import type { Agent } from '../registry/owner.ts';
import { AGENTS } from '../registry/owner.ts';
import type { Detection, Terminal } from './detect.ts';
import { AGENT_NAMES } from './detect.ts';
import type { FilePlan, InitPlan } from './init.ts';
import type { InstallResult } from './package.ts';
import { toolVersion } from './package.ts';

export interface InstallStep {
  title: string;
  done: string;
  run: (onOutput: (text: string) => void) => Promise<InstallResult>;
}

export interface InitEnding {
  notes: string[];
  backups: string | null;
  changed: boolean;
  next: { agent: Agent; text: string }[];
  askForSetup: boolean;
  failed: { command: string; dir: string; problem: string } | null;
}

export interface InitScreen {
  chooseAgents(detected: readonly Detection[]): Promise<Agent[] | null>;
  wiring(agents: readonly Agent[]): void;
  files(plan: InitPlan, check: boolean): void;
  refused(files: readonly FilePlan[]): void;
  checked(changes: number): void;
  install(step: InstallStep): Promise<InstallResult>;
  end(ending: InitEnding): void;
  stop(message: string): void;
}

const VERBS: Record<FilePlan['status'], [string, string, 'green' | 'yellow' | 'red' | 'dim']> = {
  create: ['created', 'would create', 'green'],
  update: ['updated', 'would update', 'yellow'],
  remove: ['removed', 'would remove', 'red'],
  unchanged: ['unchanged', 'unchanged', 'dim'],
  refused: ['refused', 'refused', 'red'],
};

function agentNames(agents: readonly Agent[]): string {
  return agents.map(agent => AGENT_NAMES[agent]).join(', ');
}

function role(file: FilePlan): string {
  return [...new Set(file.edits.map(edit => edit.part))].join(', ');
}

function nextLine(agent: Agent, text: string): string {
  const name = AGENT_NAMES[agent];
  return text.startsWith(name) ? `${text}.` : `${name}: ${text}.`;
}

export function terminalScreen(terminal: Terminal): InitScreen {
  const io = { input: terminal.input as NodeJS.ReadStream, output: terminal.output as NodeJS.WriteStream };
  intro(styleText('inverse', ` ${TOOL} ${toolVersion()} `), io);
  return {
    async chooseAgents(detected) {
      const found = new Map(detected.map(d => [d.agent, d.found]));
      const chosen = await multiselect<Agent>({
        ...io,
        message: 'Which agents do you use in this project?',
        options: AGENTS.map(agent => {
          const where = found.get(agent);
          return { value: agent, label: where ? `${AGENT_NAMES[agent]} ${styleText('dim', `(${where})`)}` : AGENT_NAMES[agent] };
        }),
        initialValues: detected.map(d => d.agent),
        required: true,
      });
      return isCancel(chosen) ? null : chosen;
    },
    wiring(agents) {
      log.step(`Wiring ${agentNames(agents)}`, io);
    },
    files(plan, check) {
      const touched = plan.files.filter(file => file.status !== 'unchanged');
      const rows = new Map<string, { status: FilePlan['status']; file: string; what: string; skills: number }>();
      for (const file of touched) {
        const folder = role(file) === 'skills' ? /^(.*\bskills)\//.exec(file.file)?.[1] : undefined;
        const key = folder === undefined ? `${file.status} ${file.file}` : `${file.status} ${folder}/`;
        const row = rows.get(key) ?? {
          status: file.status,
          file: folder ? `${folder}/` : file.file,
          what: role(file),
          skills: 0,
        };
        if (folder !== undefined) {
          row.skills += 1;
          row.what = `${String(row.skills)} ${row.skills === 1 ? 'skill' : 'skills'}`;
        }
        rows.set(key, row);
      }
      const width = Math.max(0, ...[...rows.values()].map(row => row.file.length));
      const lines = [...rows.values()].map(row => {
        const [done, would, colour] = VERBS[row.status];
        const verb = styleText(colour, (check ? would : done).padEnd(check ? 12 : 9));
        return `${verb} ${row.file.padEnd(width)}  ${styleText('dim', row.what)}`;
      });
      const kept = plan.files.length - touched.length;
      if (kept > 0) lines.push(styleText('dim', `${String(kept)} ${kept === 1 ? 'file' : 'files'} already up to date`));
      const title =
        touched.length === 0
          ? `The files for ${agentNames(plan.agents)} are up to date`
          : `${check ? 'Would change' : 'Wrote'} the files for ${agentNames(plan.agents)}`;
      log.success([title, ...lines].join('\n'), io);
    },
    refused(files) {
      for (const file of files) log.error(file.reason ?? file.file, io);
      cancel(`Wrote nothing. Fix ${files.length === 1 ? 'that file' : 'those files'} and run init again.`, io);
    },
    checked(changes) {
      outro(changes > 0 ? `${String(changes)} file(s) would change.` : 'Nothing would change.', io);
    },
    async install(step) {
      const shown = taskLog({ ...io, title: step.title, limit: 6, retainLog: true });
      let pending = '';
      const result = await step.run(text => {
        const lines = (pending + text).split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim() !== '') shown.message(line);
      });
      if (pending.trim() !== '') shown.message(pending);
      if (result.ok) shown.success(step.done);
      else shown.error(`${step.title} failed (${result.problem})`, { showLog: true });
      return result;
    },
    end(ending) {
      for (const text of ending.notes) log.info(text, io);
      if (ending.backups) log.info(styleText('dim', `Backed up the files it changed in ${ending.backups}`), io);
      if (ending.failed) {
        const { command, dir, problem } = ending.failed;
        log.error(
          `${command} failed (${problem}), so the hooks and the MCP server can't start yet.\nRun it in ${dir}, then you're set.`,
          io,
        );
      }
      const steps = ending.next.map(({ agent, text }) => nextLine(agent, text));
      if (ending.changed) steps.push('Commit the files above: each agent reads them from the repository.');
      note(steps.join('\n'), 'Next', io);
      outro(
        ending.askForSetup
          ? `Then ask your agent: ${styleText('bold', `"Set this project up with ${TOOL}."`)} It writes ${CONFIG_FILE}.`
          : 'Done.',
        io,
      );
    },
    stop(message) {
      cancel(message, io);
    },
  };
}
