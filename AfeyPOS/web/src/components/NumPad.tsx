/**
 * A small on-screen number keypad for touch tills. It types into the money / number field the cashier last
 * touched, exactly as the physical keyboard would, so the field's own parsing and formatting still apply.
 */
import { cx } from './ui';
import { Icon } from './icons';

/** Types one character into an input and fires the event React listens for. */
export function typeInto(el: HTMLInputElement, char: 'back' | 'clear' | string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  const next = char === 'back' ? el.value.slice(0, -1) : char === 'clear' ? '' : el.value + char;
  setter.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const KEYS: (string | 'back' | 'clear')[] = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'back'];

export function NumPad({ onPress, onEnter, enterLabel = 'Enter', className }: { onPress: (key: string) => void; onEnter?: () => void; enterLabel?: string; className?: string }) {
  return (
    <div className={cx('grid grid-cols-3 gap-1.5', className)} role="group" aria-label="Number keypad" data-testid="numpad">
      {KEYS.map((k) => (
        <button key={k} type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={k === 'back' ? 'Backspace' : k === '.' ? 'Decimal point' : k}
          onClick={() => onPress(k)}
          className="flex h-11 items-center justify-center rounded-lg border border-ink-200 bg-white text-lg font-bold text-ink-800 shadow-sm transition active:scale-95 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-white dark:hover:bg-ink-800">
          {k === 'back' ? <Icon name="undo" className="h-5 w-5" /> : k}
        </button>
      ))}
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label="Clear" onClick={() => onPress('clear')}
        className="flex h-11 items-center justify-center rounded-lg border border-ink-200 bg-ink-50 text-sm font-bold uppercase text-ink-600 shadow-sm transition active:scale-95 hover:bg-ink-100 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-200">Clear</button>
      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label="Zero" onClick={() => onPress('0')}
        className="flex h-11 items-center justify-center rounded-lg border border-ink-200 bg-white text-lg font-bold text-ink-800 shadow-sm transition active:scale-95 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-white dark:hover:bg-ink-800">0</button>
      {onEnter
        ? <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label={enterLabel} onClick={onEnter}
            className="flex h-11 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold uppercase text-white shadow-sm transition active:scale-95 hover:bg-brand-600">{enterLabel}</button>
        : <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} aria-label="Double zero" onClick={() => onPress('00')}
            className="flex h-11 items-center justify-center rounded-lg border border-ink-200 bg-white text-lg font-bold text-ink-800 shadow-sm transition active:scale-95 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-900 dark:text-white dark:hover:bg-ink-800">00</button>}
    </div>
  );
}
