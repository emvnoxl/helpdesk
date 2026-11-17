import { useState, type FormEvent } from "react";
import { ApiError, api } from "./api";
import { useNotify } from "./notify";
import { PIN_LENGTH, PinInput } from "./PinInput";
import { ThisComputer } from "./ThisComputer";
import { btn, card } from "./ui";

/** A normal user's own page: set or change the PIN, and sign out of every other computer. */
export function Account({ name, email, hasPin, onChanged }: { name: string; email: string; hasPin: boolean; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [cur, setCur] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const matches = pin.length === PIN_LENGTH && pin === pin2;
  const mismatch = pin2.length === PIN_LENGTH && pin !== pin2;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setBusy(true);
    setErr("");
    try {
      await api("/security/pin", { method: "POST", json: { current: cur, next: pin } });
      setCur(""); setPin(""); setPin2("");
      toast(hasPin ? "Every other computer was signed out." : "You'll need it to sign in on other computers.", "success", hasPin ? "PIN changed" : "PIN created");
      onChanged();
    } catch (x) {
      const d = (x as ApiError).data ?? {};
      setErr(d.attempts_left !== undefined ? `${(x as Error).message} ${d.attempts_left} tries left.` : (x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function everywhere() {
    const yes = await confirm({
      title: "Sign out of every other computer?",
      body: "Use this if you signed in on a shared or borrowed computer, or lost a laptop. You stay signed in here, and the others will ask for your PIN next time.",
      confirmLabel: "Sign them out",
    });
    if (!yes) return;
    try {
      await api("/security/signout-everywhere", { method: "POST", json: {} });
      toast("Every other computer has been signed out.", "success", "Done");
    } catch (x) {
      toast((x as Error).message, "error");
    }
  }

  return (
    <div className="grid max-w-5xl gap-6 lg:grid-cols-2">
      <section className={card + " space-y-5"}>
        <div>
          <h2 className="text-lg font-extrabold">{hasPin ? "Change your PIN" : "Create a PIN"}</h2>
          <p className="text-sm text-neutral-500">
            {hasPin
              ? "Your PIN is asked for on any computer that hasn't signed in as you before. Changing it signs you out everywhere else."
              : "You haven't set a PIN yet, so anyone who types your email on another computer could open your tickets. Create a 6-digit PIN to stop that."}
          </p>
        </div>
        <form className="max-w-sm space-y-5" onSubmit={save} noValidate>
          {hasPin && <PinInput name="current-pin" label="Current PIN" autoComplete="current-password" value={cur} onChange={setCur} disabled={busy} />}
          <PinInput name="new-pin" label={hasPin ? "New PIN" : "Choose a PIN"} autoComplete="new-password" value={pin} onChange={setPin} disabled={busy} />
          <PinInput name="new-pin2" label="Type it again" autoComplete="new-password" value={pin2} onChange={setPin2} disabled={busy} invalid={mismatch} ok={matches} hint={mismatch ? "These don't match yet." : matches ? "✓ They match." : undefined} />
          {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
          <button className={btn} disabled={busy || !matches || (hasPin && cur.length < PIN_LENGTH)}>{busy ? "Saving…" : hasPin ? "Change PIN" : "Create PIN"}</button>
        </form>
      </section>

      <div className="space-y-6">
        <section className={card + " space-y-1"}>
          <h2 className="text-lg font-extrabold">You</h2>
          <p className="text-sm"><b>{name}</b></p>
          <p className="text-sm text-neutral-500">{email}</p>
        </section>
        <ThisComputer />
        <section className={card + " space-y-3"}>
          <div>
            <h2 className="text-lg font-extrabold">Other computers</h2>
            <p className="text-sm text-neutral-500">This computer stays signed in until you sign out. If you used a shared computer, or lost one, sign every other one out.</p>
          </div>
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-stone-100" onClick={() => void everywhere()}>Sign out of other computers</button>
        </section>
      </div>
    </div>
  );
}
