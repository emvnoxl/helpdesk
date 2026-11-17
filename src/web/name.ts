// The browser remembers the last name and email typed, only to prefill the sign-in form next time
// (for example after the cookie expires). The server's session is what actually identifies the person.
const NAME_KEY = "fortress-helpdesk:name";
const EMAIL_KEY = "fortress-helpdesk:email";

function read(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

export const loadSaved = () => ({ name: read(NAME_KEY), email: read(EMAIL_KEY) });

export function saveDetails(name: string, email: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    /* prefill just won't be remembered */
  }
}

/** "Forget me here" / "don't remember me": stop prefilling the sign-in on this computer. */
export function clearSaved() {
  try {
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* nothing to clear */
  }
}
