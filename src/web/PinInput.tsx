import { useId, useRef, useState } from "react";

export const PIN_LENGTH = 6;
export const onlyDigits = (v: string) => v.replace(/\D/g, "").slice(0, PIN_LENGTH);

/** Six digit boxes backed by ONE real input laid over them, so typing, pasting, backspace, password managers and screen readers all
    behave like a normal field. Dots by default; "Show" reveals the digits. `onComplete` fires when the sixth digit is typed. */
export function PinInput({
  value, onChange, name, label, autoComplete = "off", autoFocus = false, onComplete, invalid = false, ok = false, disabled = false, hint, shakeKey,
}: {
  value: string; onChange: (v: string) => void; name: string; label: string; autoComplete?: string; autoFocus?: boolean;
  onComplete?: (v: string) => void; invalid?: boolean; ok?: boolean; disabled?: boolean; hint?: string; shakeKey?: number;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState(false);
  const [show, setShow] = useState(false);
  const active = Math.min(value.length, PIN_LENGTH - 1);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        <button type="button" className="text-xs font-semibold text-neutral-500 hover:text-fg" onClick={() => setShow((s) => !s)} aria-pressed={show}>{show ? "Hide" : "Show"}</button>
      </div>
      <div key={shakeKey} className={`relative ${shakeKey ? "pin-shake" : ""}`} onClick={() => ref.current?.focus()}>
        <div className="grid grid-cols-6 gap-2" aria-hidden>
          {Array.from({ length: PIN_LENGTH }, (_, i) => {
            const filled = i < value.length;
            const current = focus && i === active && !disabled;
            return (
              <div
                key={i}
                className={`grid h-12 place-items-center rounded-xl border bg-surface text-xl font-bold transition-colors sm:h-14 ${
                  invalid ? "border-[#d03b3b]" : ok ? "border-brand-green bg-brand-green/10" : current ? "border-brand-green ring-2 ring-brand-green/30" : filled ? "border-stone-400" : "border-stone-300"
                } ${disabled ? "opacity-60" : ""}`}
              >
                {filled ? (show ? value[i] : <span className="h-2.5 w-2.5 rounded-full bg-fg" />) : current ? <span className="pin-caret h-6 w-0.5 rounded bg-brand-green" /> : null}
              </div>
            );
          })}
        </div>
        <input
          id={id}
          ref={ref}
          name={name}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          maxLength={PIN_LENGTH}
          value={value}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? id + "-hint" : undefined}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onChange={(e) => {
            const v = onlyDigits(e.target.value);
            onChange(v);
            if (v.length === PIN_LENGTH) onComplete?.(v);
          }}
          className="absolute inset-0 h-full w-full cursor-text opacity-0"
        />
      </div>
      {hint && <p id={id + "-hint"} className={`mt-1.5 text-xs ${invalid ? "text-red-700" : ok ? "font-semibold text-ok" : "text-neutral-500"}`}>{hint}</p>}
    </div>
  );
}
