import { useEffect } from "react";

/** Tells the page which colour the screen behind the scrollbar is, so the always-visible scrollbar track blends in
 *  (dark sign-in screens and the dark Live board use "dark"; everything else is "light"). */
export function usePageTone(tone: "light" | "dark") {
  useEffect(() => {
    document.documentElement.dataset.tone = tone;
    return () => {
      document.documentElement.dataset.tone = "light";
    };
  }, [tone]);
}
