import assert from 'node:assert/strict';
import { test } from 'node:test';
import { look, sparsenessOf } from '../../src/driver/look.ts';
import { INTERACTIVE_ROLES, parseInspectScreen, roleOfElementType } from '../../src/driver/tree.ts';
import { androidReadable, raw, read, readable } from './fixtures.ts';

interface AxElement {
  elementType: number;
  identifier: string;
  frame: { X: number; Y: number; Width: number; Height: number };
  children?: AxElement[];
}

function rawInteractiveIds(screen: string): { nodes: number; interactive: number; ids: string[] } {
  const data = JSON.parse(raw(screen, 'runner')) as { axElement: AxElement };
  let nodes = 0;
  let interactive = 0;
  const ids: string[] = [];
  const walk = (element: AxElement) => {
    nodes += 1;
    const { X, Y, Width, Height } = element.frame;
    const onScreen = Width > 0 && Height > 0 && X < 402 && Y < 874 && X + Width > 0 && Y + Height > 0;
    if (onScreen && INTERACTIVE_ROLES.has(roleOfElementType(element.elementType))) {
      interactive += 1;
      if (element.identifier) ids.push(element.identifier);
    }
    for (const child of element.children ?? []) walk(child);
  };
  walk(data.axElement);
  return { nodes, interactive, ids };
}

test('interactive-only look lists every on-screen interactive element that has an id, by id', () => {
  for (const screen of ['settings', 'settings-general', 'springboard', 'maps-home', 'contacts', 'files']) {
    const expected = rawInteractiveIds(screen);
    const result = look(read(screen), { interactiveOnly: true });
    for (const id of new Set(expected.ids)) {
      const token = /^[\w.:/-]+$/.test(id) ? id : JSON.stringify(id);
      assert.ok(
        result.lines.some(line => line.includes(`id=${token} `) || line.endsWith(`id=${token}`)),
        `${screen}: missing ${id}\n${result.text}`,
      );
    }
    assert.equal(result.interactive !== undefined && result.shown <= result.interactive, true, screen);
  }
  assert.ok(rawInteractiveIds('settings').ids.includes('com.apple.settings.general'));
});

test('a look line carries role, id and label together, and bounds on request', () => {
  const plain = look(read('settings'), { interactiveOnly: true });
  assert.ok(plain.lines.includes('[button] id=com.apple.settings.general "General"'), plain.text);
  const withBounds = look(read('settings'), { interactiveOnly: true, bounds: true });
  assert.ok(withBounds.lines.includes('[button] id=com.apple.settings.general "General" [16,380][386,432]'), withBounds.text);
});

test('look summarises off-screen content in one line', () => {
  const result = look(read('settings'), { interactiveOnly: true });
  assert.equal(result.text.split('\n').at(-1), 'Off-screen: 1 below ("Passcode").');
  assert.equal(result.offScreen.below, 1);
});

test('within shows one subtree, found by id or by label', () => {
  const byId = look(read('settings-general'), { within: 'About' });
  assert.deepEqual(byId.lines, ['[cell] id=About "About"', '  [button] "chevron" disabled']);
  const byLabel = look(read('settings'), {
    within: 'apple account, sign in to access your icloud data, the app store, apple services, and more.',
  });
  assert.equal(
    byLabel.lines[0],
    '[button] id=com.apple.settings.primaryAppleAccount "Apple Account, Sign in to access your iCloud data, the App Store, Apple services, and more."',
  );
  const missing = look(read('settings'), { within: 'Nowhere' });
  assert.match(missing.text, /^Nothing on screen has the id or label "Nowhere"; showing the whole screen\./);
});

test('depth limits how many levels of shown elements are printed', () => {
  const full = look(read('settings'));
  const top = look(read('settings'), { depth: 1 });
  assert.ok(top.lines.length < full.lines.length);
  assert.ok(
    top.lines.every(line => !line.startsWith(' ')),
    top.text,
  );
  const two = look(read('settings'), { depth: 2 });
  assert.ok(
    two.lines.every(line => !line.startsWith('    ')),
    two.text,
  );
  assert.ok(
    two.lines.some(line => line.startsWith('  [button] id=com.apple.settings.general')),
    two.text,
  );
});

test('a canvas page Safari draws but cannot describe is nearly empty and asks for a screenshot', () => {
  for (const form of ['runner', 'inspect'] as const) {
    const result = look(read('safari-canvas', form));
    assert.equal(result.attachScreenshot, true);
    assert.match(
      result.text,
      /This read is nearly empty \(90% of the screen's height has no readable element\): a screenshot is attached/,
    );
  }
});

test('ordinary stock screens are not nearly empty', () => {
  for (const screen of ['settings', 'settings-general', 'springboard', 'files', 'contacts', 'maps-home']) {
    for (const form of ['runner', 'inspect'] as const) {
      const sparseness = sparsenessOf(readable(screen, form));
      assert.equal(sparseness.sparse, false, `${screen}.${form}: ${sparseness.reason ?? ''}`);
    }
  }
});

test('a sheet with five elements below the status bar is nearly empty, complete or not', () => {
  for (const screen of ['maps-notifications-sheet', 'maps-ads-sheet']) {
    const sparseness = sparsenessOf(readable(screen));
    assert.equal(sparseness.sparse, true, screen);
    assert.equal(sparseness.content, 5);
  }
});

test('a short page with a blank lower half reads as nearly empty: the tree alone cannot tell it from a canvas', () => {
  const sparseness = sparsenessOf(readable('progress-1'));
  assert.equal(sparseness.sparse, true);
  assert.equal(sparseness.content, 12);
});

test('inspect_screen reads carry no element types: interactive-only says so and shows every element', () => {
  const result = look(read('settings', 'inspect'), { interactiveOnly: true });
  assert.match(result.text, /^This read carries no element types, so interactive-only shows every element\./);
  assert.ok(
    result.lines.some(line => line.trim() === 'id=com.apple.settings.general "General"'),
    result.text,
  );
  assert.equal(result.interactive, undefined);
});

test('an inspect_screen read with a class attribute gets roles', () => {
  const compact = JSON.stringify({
    elements: [
      {
        b: '[0,0][402,874]',
        cls: 'XCUIElementTypeApplication',
        a11y: 'Demo',
        c: [
          { b: '[10,100][200,140]', cls: 'Button', rid: 'save', a11y: 'Save' },
          { b: '[10,150][200,190]', cls: '48', a11y: 'Saved 3 items' },
        ],
      },
    ],
  });
  const result = look(parseInspectScreen(compact), { interactiveOnly: true });
  assert.deepEqual(result.lines, ['[button] id=save "Save"']);
});

test('an unreadable read asks for a screenshot instead of listing nothing', () => {
  const result = look(parseInspectScreen('Failed to inspect screen: Unable to connect to the runner'));
  assert.equal(result.attachScreenshot, true);
  assert.equal(
    result.text,
    'Unreadable screen: The screen read is not a view tree: Failed to inspect screen: Unable to connect to the runner. A screenshot is attached; tap by point.',
  );
});

test('the Viewer prefix stock Maestro puts before inspect_screen JSON is skipped', () => {
  const prefixed = `Important: Maestro Viewer is available at http://127.0.0.1:10003/. Make sure to surface this link.\n${raw('settings', 'inspect')}`;
  assert.deepEqual(look(parseInspectScreen(prefixed)).lines, look(read('settings', 'inspect')).lines);
});

test('an Android read leaves out the status bar, so a look starts with the app and lists no System UI id', () => {
  const launcher = androidReadable('launcher');
  assert.deepEqual(launcher.screen, { x1: 0, y1: 0, x2: 1080, y2: 2400 });
  const full = look(launcher);
  assert.equal(full.lines[0]?.trim(), '[other] id=android:id/content');
  assert.doesNotMatch(full.text, /systemui|1:29 AM|Battery charging|signal full/);
  assert.ok(
    full.lines.some(line => line.trim() === '[button] "Gmail"'),
    full.text,
  );
  const interactive = look(launcher, { interactiveOnly: true });
  assert.doesNotMatch(interactive.text, /systemui/);
  assert.ok(
    interactive.lines.some(line => line.trim() === '[button] "Chrome"'),
    interactive.text,
  );
});

test("interactive-only on the example's Android home lists the app's controls and none of the status bar's", () => {
  const ids = look(androidReadable('example-home'), { interactiveOnly: true }).lines.map(line => /id=(\S+)/.exec(line)?.[1]);
  assert.deepEqual(ids, [
    'home-increment',
    'home-name-input',
    'home-notify-switch',
    'home-open-sheet',
    'home-open-details',
    'home-open-api',
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `row-${String(n)}`),
  ]);
});

test('an Android read keeps a System UI window that is not a bar along an edge, such as the notification shade', () => {
  const statusBar = {
    b: '[0,0][1080,74]',
    cls: 'android.widget.FrameLayout',
    c: [
      {
        b: '[42,45][146,74]',
        a11y: '1:29 AM',
        txt: '1:29',
        rid: 'com.android.systemui:id/clock',
        cls: 'android.widget.TextView',
      },
    ],
  };
  const navigationBar = {
    b: '[0,2274][1080,2400]',
    cls: 'android.widget.FrameLayout',
    c: [
      {
        b: '[440,2274][640,2400]',
        a11y: 'Home',
        rid: 'com.android.systemui:id/home',
        cls: 'android.widget.ImageView',
        clickable: true,
      },
    ],
  };
  const shade = {
    b: '[0,0][1080,2400]',
    cls: 'android.widget.FrameLayout',
    c: [
      {
        b: '[0,300][1080,500]',
        a11y: 'Build finished',
        rid: 'com.android.systemui:id/notification_stack_scroller',
        cls: 'android.view.ViewGroup',
        clickable: true,
      },
    ],
  };
  const app = {
    b: '[0,0][1080,2400]',
    cls: 'android.widget.FrameLayout',
    c: [{ b: '[100,600][500,700]', rid: 'save', a11y: 'Save', cls: 'android.widget.Button', clickable: true }],
  };
  const compact = JSON.stringify({
    ui_schema: { platform: 'android' },
    elements: [{ c: [statusBar, shade, app, navigationBar] }],
  });
  const result = look(parseInspectScreen(compact), { interactiveOnly: true });
  assert.deepEqual(result.lines, [
    '[button] id=com.android.systemui:id/notification_stack_scroller "Build finished"',
    '[button] id=save "Save"',
  ]);
});
