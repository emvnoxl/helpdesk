import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/** Draws its children straight into <body>. A dialog inside a page that is sliding in (an animated ancestor) would be trapped inside it: position:fixed
    then covers only that part of the screen instead of the whole window. Dialogs go through this. */
export const Portal = ({ children }: { children: ReactNode }) => createPortal(children, document.body);
