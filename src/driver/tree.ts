export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Role =
  | 'alert'
  | 'app'
  | 'button'
  | 'cell'
  | 'checkbox'
  | 'field'
  | 'group'
  | 'icon'
  | 'image'
  | 'key'
  | 'keyboard'
  | 'link'
  | 'list'
  | 'map'
  | 'menu'
  | 'menuitem'
  | 'navbar'
  | 'other'
  | 'picker'
  | 'progress'
  | 'scroll'
  | 'search'
  | 'secure-field'
  | 'segmented'
  | 'sheet'
  | 'slider'
  | 'statusbar'
  | 'stepper'
  | 'switch'
  | 'tab'
  | 'tabbar'
  | 'text'
  | 'textview'
  | 'toolbar'
  | 'web'
  | 'window';

export interface UiNode {
  role: Role | undefined;
  id: string;
  label: string;
  text: string;
  value: string;
  hint: string;
  bounds: Rect | undefined;
  enabled: boolean;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  children: UiNode[];
}

export type ReadSource = 'inspect_screen' | 'runner';

export interface ReadableScreen {
  readable: true;
  source: ReadSource;
  typed: boolean;
  screen: Rect;
  root: UiNode;
}

export interface UnreadableScreen {
  readable: false;
  source: ReadSource;
  reason: string;
}

export type ScreenRead = ReadableScreen | UnreadableScreen;

// XCUIElement.ElementType raw values, in Apple's declaration order (XCUIElementTypes.h).
const XCUI_ELEMENT_TYPES = [
  'Any',
  'Other',
  'Application',
  'Group',
  'Window',
  'Sheet',
  'Drawer',
  'Alert',
  'Dialog',
  'Button',
  'RadioButton',
  'RadioGroup',
  'CheckBox',
  'DisclosureTriangle',
  'PopUpButton',
  'ComboBox',
  'MenuButton',
  'ToolbarButton',
  'Popover',
  'Keyboard',
  'Key',
  'NavigationBar',
  'TabBar',
  'TabGroup',
  'Toolbar',
  'StatusBar',
  'Table',
  'TableRow',
  'TableColumn',
  'Outline',
  'OutlineRow',
  'Browser',
  'CollectionView',
  'Slider',
  'PageIndicator',
  'ProgressIndicator',
  'ActivityIndicator',
  'SegmentedControl',
  'Picker',
  'PickerWheel',
  'Switch',
  'Toggle',
  'Link',
  'Image',
  'Icon',
  'SearchField',
  'ScrollView',
  'ScrollBar',
  'StaticText',
  'TextField',
  'SecureTextField',
  'DatePicker',
  'TextView',
  'Menu',
  'MenuItem',
  'MenuBar',
  'MenuBarItem',
  'Map',
  'WebView',
  'IncrementArrow',
  'DecrementArrow',
  'Timeline',
  'RatingIndicator',
  'ValueIndicator',
  'SplitGroup',
  'Splitter',
  'RelevanceIndicator',
  'ColorWell',
  'HelpTag',
  'Matte',
  'DockItem',
  'Ruler',
  'RulerMarker',
  'Grid',
  'LevelIndicator',
  'Cell',
  'LayoutArea',
  'LayoutItem',
  'Handle',
  'Stepper',
  'Tab',
  'TouchBar',
  'StatusItem',
] as const;

const ROLE_BY_TYPE: Record<string, Role> = {
  Application: 'app',
  Window: 'window',
  Group: 'group',
  Sheet: 'sheet',
  Drawer: 'sheet',
  Popover: 'sheet',
  Alert: 'alert',
  Dialog: 'alert',
  Button: 'button',
  ToolbarButton: 'button',
  PopUpButton: 'button',
  MenuButton: 'button',
  DisclosureTriangle: 'button',
  IncrementArrow: 'button',
  DecrementArrow: 'button',
  RadioButton: 'checkbox',
  CheckBox: 'checkbox',
  Switch: 'switch',
  Toggle: 'switch',
  Link: 'link',
  Cell: 'cell',
  TableRow: 'cell',
  OutlineRow: 'cell',
  StaticText: 'text',
  TextField: 'field',
  ComboBox: 'field',
  SecureTextField: 'secure-field',
  SearchField: 'search',
  TextView: 'textview',
  Image: 'image',
  Icon: 'icon',
  DockItem: 'icon',
  Keyboard: 'keyboard',
  Key: 'key',
  NavigationBar: 'navbar',
  TabBar: 'tabbar',
  TabGroup: 'tabbar',
  Tab: 'tab',
  Toolbar: 'toolbar',
  StatusBar: 'statusbar',
  Table: 'list',
  Outline: 'list',
  CollectionView: 'list',
  Grid: 'list',
  ScrollView: 'scroll',
  Slider: 'slider',
  Stepper: 'stepper',
  Picker: 'picker',
  PickerWheel: 'picker',
  DatePicker: 'picker',
  SegmentedControl: 'segmented',
  ProgressIndicator: 'progress',
  ActivityIndicator: 'progress',
  PageIndicator: 'progress',
  Menu: 'menu',
  MenuItem: 'menuitem',
  MenuBarItem: 'menuitem',
  Map: 'map',
  WebView: 'web',
};

export const INTERACTIVE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'button',
  'cell',
  'checkbox',
  'field',
  'icon',
  'link',
  'menuitem',
  'picker',
  'search',
  'secure-field',
  'segmented',
  'slider',
  'stepper',
  'switch',
  'tab',
  'textview',
]);

// Android view classes by their simple name, as uiautomator reports them (a view's getAccessibilityClassName). React
// Native reports a view with an accessibilityRole under the matching widget class, and a Pressable without one as a
// clickable android.view.ViewGroup.
const ROLE_BY_ANDROID_CLASS: Record<string, Role> = {
  Button: 'button',
  ImageButton: 'button',
  AppCompatButton: 'button',
  AppCompatImageButton: 'button',
  MaterialButton: 'button',
  FloatingActionButton: 'button',
  ExtendedFloatingActionButton: 'button',
  EditText: 'field',
  AutoCompleteTextView: 'field',
  MultiAutoCompleteTextView: 'field',
  AppCompatEditText: 'field',
  TextInputEditText: 'field',
  Switch: 'switch',
  SwitchCompat: 'switch',
  SwitchMaterial: 'switch',
  MaterialSwitch: 'switch',
  ToggleButton: 'switch',
  CheckBox: 'checkbox',
  AppCompatCheckBox: 'checkbox',
  MaterialCheckBox: 'checkbox',
  RadioButton: 'checkbox',
  AppCompatRadioButton: 'checkbox',
  MaterialRadioButton: 'checkbox',
  CheckedTextView: 'checkbox',
  TextView: 'text',
  AppCompatTextView: 'text',
  MaterialTextView: 'text',
  ImageView: 'image',
  AppCompatImageView: 'image',
  ShapeableImageView: 'image',
  ScrollView: 'scroll',
  HorizontalScrollView: 'scroll',
  NestedScrollView: 'scroll',
  RecyclerView: 'list',
  ListView: 'list',
  GridView: 'list',
  SeekBar: 'slider',
  AppCompatSeekBar: 'slider',
  Slider: 'slider',
  RangeSlider: 'slider',
  RatingBar: 'slider',
  ProgressBar: 'progress',
  LinearProgressIndicator: 'progress',
  CircularProgressIndicator: 'progress',
  WebView: 'web',
  Spinner: 'picker',
  AppCompatSpinner: 'picker',
  NumberPicker: 'picker',
  DatePicker: 'picker',
  TimePicker: 'picker',
  TabWidget: 'tabbar',
  TabLayout: 'tabbar',
  Toolbar: 'toolbar',
  MaterialToolbar: 'toolbar',
};

/** The role of an Android view: its class's, or a button for a clickable view whose class names no control. */
export function roleOfAndroidClass(className: string, clickable: boolean): Role {
  const simple = className.slice(className.lastIndexOf('.') + 1);
  const role = ROLE_BY_ANDROID_CLASS[simple] ?? 'other';
  return clickable && !INTERACTIVE_ROLES.has(role) ? 'button' : role;
}

export function roleOfElementType(elementType: number | string): Role {
  const name =
    typeof elementType === 'number' || /^\d+$/.test(elementType)
      ? XCUI_ELEMENT_TYPES[Number(elementType)]
      : elementType.replace(/^XCUIElementType/, '');
  return (name === undefined ? undefined : ROLE_BY_TYPE[name]) ?? 'other';
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

export function parseBounds(text: string | undefined): Rect | undefined {
  const match = BOUNDS.exec(text ?? '');
  if (!match) return undefined;
  const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
  return { x1, y1, x2, y2 };
}

export function formatBounds(rect: Rect): string {
  return `[${String(rect.x1)},${String(rect.y1)}][${String(rect.x2)},${String(rect.y2)}]`;
}

export function area(rect: Rect): number {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function screenOf(root: UiNode): Rect | undefined {
  const queue = [root];
  for (let node = queue.shift(); node; node = queue.shift()) {
    if (node.bounds && area(node.bounds) > 0) return node.bounds;
    queue.push(...node.children);
  }
  return undefined;
}

// An Android read holds one tree per window, the status and navigation bars' among them, and uiautomator clips every
// node's bounds to the display, so the largest node is the display.
function androidScreenOf(root: UiNode): Rect | undefined {
  let best: Rect | undefined;
  const walk = (node: UiNode) => {
    if (node.bounds && area(node.bounds) > (best ? area(best) : 0)) best = node.bounds;
    node.children.forEach(walk);
  };
  walk(root);
  return best;
}

const SYSTEM_BAR_SHARE = 0.07;
const SYSTEM_UI_ID = 'com.android.systemui:id/';

function systemUiOnly(node: UiNode): boolean {
  let ids = 0;
  const walk = (n: UiNode): boolean => {
    if (n.id !== '') {
      if (!n.id.startsWith(SYSTEM_UI_ID)) return false;
      ids += 1;
    }
    return n.children.every(walk);
  };
  return walk(node) && ids > 0;
}

function edgeStrip(bounds: Rect | undefined, screen: Rect): boolean {
  if (!bounds) return false;
  const width = screen.x2 - screen.x1;
  const height = screen.y2 - screen.y1;
  const across = bounds.x1 <= screen.x1 && bounds.x2 >= screen.x2;
  const down = bounds.y1 <= screen.y1 && bounds.y2 >= screen.y2;
  const atTopOrBottom = bounds.y1 <= screen.y1 || bounds.y2 >= screen.y2;
  const atLeftOrRight = bounds.x1 <= screen.x1 || bounds.x2 >= screen.x2;
  return (
    (across && atTopOrBottom && bounds.y2 - bounds.y1 <= height * SYSTEM_BAR_SHARE) ||
    (down && atLeftOrRight && bounds.x2 - bounds.x1 <= width * SYSTEM_BAR_SHARE)
  );
}

/** Drops Android's status and navigation bars: System UI windows drawn as a strip along an edge of the display. */
function withoutSystemBars(node: UiNode, screen: Rect): UiNode {
  return {
    ...node,
    children: node.children
      .filter(child => !(edgeStrip(child.bounds, screen) && systemUiOnly(child)))
      .map(child => withoutSystemBars(child, screen)),
  };
}

function finish(source: ReadSource, typed: boolean, root: UiNode, android = false): ScreenRead {
  const screen = android ? androidScreenOf(root) : screenOf(root);
  if (!screen) return { readable: false, source, reason: 'The screen read has no element with a size.' };
  return { readable: true, source, typed, screen, root: android ? withoutSystemBars(root, screen) : root };
}

function fromCompact(element: Record<string, unknown>, android: boolean): UiNode {
  const cls = str(element.cls);
  return {
    role: android ? roleOfAndroidClass(cls, element.clickable === true) : cls ? roleOfElementType(cls) : undefined,
    id: str(element.rid),
    label: str(element.a11y),
    text: str(element.txt),
    value: str(element.val),
    hint: str(element.hint),
    bounds: parseBounds(str(element.b)),
    enabled: element.enabled !== false,
    focused: element.focused === true,
    selected: element.selected === true,
    checked: element.checked === true,
    children: records(element.c).map(child => fromCompact(child, android)),
  };
}

/** Parses Maestro's `inspect_screen` text: compact JSON with `ui_schema` and `elements`, after any prose prefix. */
export function parseInspectScreen(output: string): ScreenRead {
  const start = output.indexOf('{');
  if (start < 0) return { readable: false, source: 'inspect_screen', reason: unreadableText(output) };
  let data: unknown;
  try {
    data = JSON.parse(output.slice(start));
  } catch {
    return { readable: false, source: 'inspect_screen', reason: unreadableText(output) };
  }
  if (!isRecord(data) || !Array.isArray(data.elements)) {
    return { readable: false, source: 'inspect_screen', reason: 'The screen read has no element list.' };
  }
  const android = isRecord(data.ui_schema) && data.ui_schema.platform === 'android';
  const children = records(data.elements).map(element => fromCompact(element, android));
  const typed =
    children.length > 0 &&
    children.every(function hasRole(node): boolean {
      return node.role !== undefined && node.children.every(hasRole);
    });
  const root: UiNode = { ...emptyNode(), children };
  return finish('inspect_screen', typed, root, android);
}

function unreadableText(output: string): string {
  const firstLine = output.trim().split('\n')[0] ?? '';
  return firstLine ? `The screen read is not a view tree: ${firstLine.slice(0, 200)}` : 'The screen read is empty.';
}

function fromAxElement(element: Record<string, unknown>): UiNode {
  const frame = isRecord(element.frame) ? element.frame : {};
  const x = Number(frame.X ?? 0);
  const y = Number(frame.Y ?? 0);
  const title = str(element.title);
  const value = str(element.value);
  const role = roleOfElementType(typeof element.elementType === 'number' ? element.elementType : 0);
  return {
    role,
    id: str(element.identifier),
    label: str(element.label),
    text: title || value,
    value,
    hint: str(element.placeholderValue),
    bounds: {
      x1: Math.trunc(x),
      y1: Math.trunc(y),
      x2: Math.trunc(x + Number(frame.Width ?? 0)),
      y2: Math.trunc(y + Number(frame.Height ?? 0)),
    },
    enabled: element.enabled !== false,
    focused: element.hasFocus === true,
    selected: element.selected === true,
    checked: (role === 'switch' || role === 'checkbox') && value === '1',
    children: records(element.children).map(fromAxElement),
  };
}

/** Parses the iOS runner's `/viewHierarchy` response (`{depth, axElement}`), which carries element types. */
export function parseRunnerHierarchy(output: string): ScreenRead {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return { readable: false, source: 'runner', reason: unreadableText(output) };
  }
  if (!isRecord(data) || !isRecord(data.axElement)) {
    return { readable: false, source: 'runner', reason: 'The screen read has no root element.' };
  }
  return finish('runner', true, fromAxElement(data.axElement));
}

export function emptyNode(): UiNode {
  return {
    role: undefined,
    id: '',
    label: '',
    text: '',
    value: '',
    hint: '',
    bounds: undefined,
    enabled: true,
    focused: false,
    selected: false,
    checked: false,
    children: [],
  };
}
