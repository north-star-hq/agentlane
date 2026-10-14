import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookAtPage, parseAriaSnapshot } from '../../src/browser/aria.ts';

const PLAYWRIGHT = `- generic [active] [ref=e1]:
  - heading "Signed out" [level=1] [ref=e2]
  - button "Go" [ref=e3]
  - link "Next" [ref=e4] [cursor=pointer]:
    - /url: /next
  - textbox "Email" [ref=e5]
  - list:
    - listitem: First "quoted" item
    - checkbox "Remember me" [checked] [ref=e6]
`;

const AGENT_BROWSER = `- heading "Signed out" [level=1, ref=e1]
- button "Go" [ref=e2]
- link "Next" [ref=e3]
- textbox "Email" [ref=e4]
`;

const PAGE = { url: 'http://localhost:41300/', title: 'Fixture' };

test("playwright-cli's snapshot parses into roles, names, refs, states, text and the link's URL", () => {
  const [root] = parseAriaSnapshot(PLAYWRIGHT);
  assert.equal(root?.role, 'generic');
  assert.equal(root.ref, 'e1');
  const [heading, button, link, textbox, list] = root.children;
  assert.deepEqual(heading, {
    role: 'heading',
    name: 'Signed out',
    ref: 'e2',
    attributes: { level: '1' },
    text: null,
    props: {},
    children: [],
  });
  assert.equal(button?.ref, 'e3');
  assert.equal(link?.props.url, '/next');
  assert.equal(link.attributes.cursor, 'pointer');
  assert.equal(textbox?.name, 'Email');
  assert.equal(list?.children[0]?.text, 'First "quoted" item');
  assert.equal(list.children[1]?.attributes.checked, true);
});

test('look renders a page as it renders a device screen: a header, then one line per element, nested, with refs', () => {
  const look = lookAtPage({ ...PAGE, tree: parseAriaSnapshot(PLAYWRIGHT) });
  assert.equal(
    look.text,
    [
      'Page: "Fixture" at http://localhost:41300/',
      '[generic] ref=e1',
      '  [heading] ref=e2 "Signed out" level=1',
      '  [button] ref=e3 "Go"',
      '  [link] ref=e4 "Next" url=/next',
      '  [textbox] ref=e5 "Email"',
      '  [listitem] text="First \\"quoted\\" item"',
      '  [checkbox] ref=e6 "Remember me" checked',
    ].join('\n'),
  );
  assert.equal(look.interactive, 4);
});

test("agent-browser's snapshot, refs inside one bracket, reads the same", () => {
  const look = lookAtPage({ ...PAGE, tree: parseAriaSnapshot(AGENT_BROWSER) }, { interactiveOnly: true });
  assert.deepEqual(look.lines, ['[button] ref=e2 "Go"', '[link] ref=e3 "Next"', '[textbox] ref=e4 "Email"']);
  const heading = parseAriaSnapshot(AGENT_BROWSER)[0];
  assert.deepEqual(heading?.attributes, { level: '1' });
  assert.equal(heading.ref, 'e1');
});

test('look narrows to an element by ref or name and by depth, and says when nothing matches', () => {
  const tree = parseAriaSnapshot(PLAYWRIGHT);
  assert.deepEqual(lookAtPage({ ...PAGE, tree }, { within: 'e4' }).lines, ['[link] ref=e4 "Next" url=/next']);
  assert.deepEqual(lookAtPage({ ...PAGE, tree }, { depth: 1 }).lines, ['[generic] ref=e1']);
  const missing = lookAtPage({ ...PAGE, tree }, { within: 'nope' });
  assert.match(missing.text, /Nothing on the page has the ref or name "nope"; showing the whole page\./);
  assert.match(
    lookAtPage({ ...PAGE, title: '', tree: [] }, { interactiveOnly: true }).text,
    /^Page: \(no title\) at .*\nNothing interactive is on the page\.$/,
  );
});
