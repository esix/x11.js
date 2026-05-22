// DOM KeyboardEvent.code → X11 keycode (evdev numbering, kernel keycode + 8).
// X11 keycode → up to 4 keysyms (column 0 = no modifier, 1 = shift, 2 = mode_switch, 3 = mode_switch+shift).
// For now we populate columns 0 and 1 only — enough for typing into xterm.

const Esc = 0xff1b, Tab = 0xff09, BackSpace = 0xff08, Return = 0xff0d;
const Shift_L = 0xffe1, Shift_R = 0xffe2;
const Control_L = 0xffe3, Control_R = 0xffe4;
const Alt_L = 0xffe9, Alt_R = 0xffea;
const Meta_L = 0xffe7, Super_L = 0xffeb;
const Caps_Lock = 0xffe5, Num_Lock = 0xff7f;
const Home = 0xff50, Left = 0xff51, Up = 0xff52, Right = 0xff53, Down = 0xff54;
const Page_Up = 0xff55, Page_Down = 0xff56, End = 0xff57;
const Insert = 0xff63, Delete = 0xffff;
const F1 = 0xffbe, F2 = 0xffbf, F3 = 0xffc0, F4 = 0xffc1, F5 = 0xffc2;
const F6 = 0xffc3, F7 = 0xffc4, F8 = 0xffc5, F9 = 0xffc6, F10 = 0xffc7;
const F11 = 0xffc8, F12 = 0xffc9;

// ASCII keysyms are just the codepoint.
function ks(s: string): number { return s.charCodeAt(0); }

export const MIN_KEYCODE = 8;
export const MAX_KEYCODE = 255;
export const KEYSYMS_PER_KEYCODE = 2;

// kc → [no-mod, shift]
const KEYCODE_TO_KEYSYMS: Map<number, [number, number]> = new Map([
  [9,  [Esc, Esc]],
  [10, [ks('1'), ks('!')]],
  [11, [ks('2'), ks('@')]],
  [12, [ks('3'), ks('#')]],
  [13, [ks('4'), ks('$')]],
  [14, [ks('5'), ks('%')]],
  [15, [ks('6'), ks('^')]],
  [16, [ks('7'), ks('&')]],
  [17, [ks('8'), ks('*')]],
  [18, [ks('9'), ks('(')]],
  [19, [ks('0'), ks(')')]],
  [20, [ks('-'), ks('_')]],
  [21, [ks('='), ks('+')]],
  [22, [BackSpace, BackSpace]],
  [23, [Tab, Tab]],
  [24, [ks('q'), ks('Q')]],
  [25, [ks('w'), ks('W')]],
  [26, [ks('e'), ks('E')]],
  [27, [ks('r'), ks('R')]],
  [28, [ks('t'), ks('T')]],
  [29, [ks('y'), ks('Y')]],
  [30, [ks('u'), ks('U')]],
  [31, [ks('i'), ks('I')]],
  [32, [ks('o'), ks('O')]],
  [33, [ks('p'), ks('P')]],
  [34, [ks('['), ks('{')]],
  [35, [ks(']'), ks('}')]],
  [36, [Return, Return]],
  [37, [Control_L, Control_L]],
  [38, [ks('a'), ks('A')]],
  [39, [ks('s'), ks('S')]],
  [40, [ks('d'), ks('D')]],
  [41, [ks('f'), ks('F')]],
  [42, [ks('g'), ks('G')]],
  [43, [ks('h'), ks('H')]],
  [44, [ks('j'), ks('J')]],
  [45, [ks('k'), ks('K')]],
  [46, [ks('l'), ks('L')]],
  [47, [ks(';'), ks(':')]],
  [48, [ks("'"), ks('"')]],
  [49, [ks('`'), ks('~')]],
  [50, [Shift_L, Shift_L]],
  [51, [ks('\\'), ks('|')]],
  [52, [ks('z'), ks('Z')]],
  [53, [ks('x'), ks('X')]],
  [54, [ks('c'), ks('C')]],
  [55, [ks('v'), ks('V')]],
  [56, [ks('b'), ks('B')]],
  [57, [ks('n'), ks('N')]],
  [58, [ks('m'), ks('M')]],
  [59, [ks(','), ks('<')]],
  [60, [ks('.'), ks('>')]],
  [61, [ks('/'), ks('?')]],
  [62, [Shift_R, Shift_R]],
  [64, [Alt_L, Meta_L]],
  [65, [ks(' '), ks(' ')]],
  [66, [Caps_Lock, Caps_Lock]],
  [67, [F1, F1]],
  [68, [F2, F2]],
  [69, [F3, F3]],
  [70, [F4, F4]],
  [71, [F5, F5]],
  [72, [F6, F6]],
  [73, [F7, F7]],
  [74, [F8, F8]],
  [75, [F9, F9]],
  [76, [F10, F10]],
  [77, [Num_Lock, Num_Lock]],
  [95, [F11, F11]],
  [96, [F12, F12]],
  [105, [Control_R, Control_R]],
  [108, [Alt_R, Meta_L]],
  [110, [Home, Home]],
  [111, [Up, Up]],
  [112, [Page_Up, Page_Up]],
  [113, [Left, Left]],
  [114, [Right, Right]],
  [115, [End, End]],
  [116, [Down, Down]],
  [117, [Page_Down, Page_Down]],
  [118, [Insert, Insert]],
  [119, [Delete, Delete]],
  [133, [Super_L, Super_L]],
]);

// Modifier groups (X11 expects these as keycode lists).
export const MODIFIER_MAP: ReadonlyArray<ReadonlyArray<number>> = [
  [50, 62],          // Shift
  [66],              // Lock (CapsLock)
  [37, 105],         // Control
  [64, 108],         // Mod1 (Alt)
  [],                // Mod2
  [],                // Mod3
  [133],             // Mod4 (Super)
  [],                // Mod5
];

const DOM_CODE_TO_KEYCODE: Record<string, number> = {
  Escape: 9,
  Digit1: 10, Digit2: 11, Digit3: 12, Digit4: 13, Digit5: 14,
  Digit6: 15, Digit7: 16, Digit8: 17, Digit9: 18, Digit0: 19,
  Minus: 20, Equal: 21, Backspace: 22, Tab: 23,
  KeyQ: 24, KeyW: 25, KeyE: 26, KeyR: 27, KeyT: 28,
  KeyY: 29, KeyU: 30, KeyI: 31, KeyO: 32, KeyP: 33,
  BracketLeft: 34, BracketRight: 35, Enter: 36,
  ControlLeft: 37,
  KeyA: 38, KeyS: 39, KeyD: 40, KeyF: 41, KeyG: 42,
  KeyH: 43, KeyJ: 44, KeyK: 45, KeyL: 46,
  Semicolon: 47, Quote: 48, Backquote: 49,
  ShiftLeft: 50, Backslash: 51,
  KeyZ: 52, KeyX: 53, KeyC: 54, KeyV: 55, KeyB: 56, KeyN: 57, KeyM: 58,
  Comma: 59, Period: 60, Slash: 61,
  ShiftRight: 62,
  AltLeft: 64, Space: 65, CapsLock: 66,
  F1: 67, F2: 68, F3: 69, F4: 70, F5: 71,
  F6: 72, F7: 73, F8: 74, F9: 75, F10: 76,
  NumLock: 77, F11: 95, F12: 96,
  ControlRight: 105, AltRight: 108,
  Home: 110, ArrowUp: 111, PageUp: 112,
  ArrowLeft: 113, ArrowRight: 114,
  End: 115, ArrowDown: 116, PageDown: 117,
  Insert: 118, Delete: 119,
  MetaLeft: 133, MetaRight: 134, OSLeft: 133, OSRight: 134,
};

export function domEventToKeycode(ev: KeyboardEvent): number | undefined {
  return DOM_CODE_TO_KEYCODE[ev.code];
}

// Fill `out` with keysyms for keycodes [first..first+count), perKey columns each.
// Unknown keycodes get NoSymbol (0).
export function fillKeysymRange(first: number, count: number, perKey: number, out: Uint32Array) {
  for (let i = 0; i < count; i++) {
    const syms = KEYCODE_TO_KEYSYMS.get(first + i);
    if (!syms) continue;
    for (let j = 0; j < Math.min(perKey, syms.length); j++) {
      out[i * perKey + j] = syms[j]!;
    }
  }
}
