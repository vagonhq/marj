/** Jump straight there — a smooth scroll across a long diff takes seconds — and mark the landing spot. */
export function flashElement(el: Element | null, block: ScrollLogicalPosition): void {
  if (!el) return;
  el.scrollIntoView({ behavior: 'auto', block });
  el.classList.remove('flash');
  void (el as HTMLElement).offsetWidth; // restart the animation when jumping to the same target twice
  el.classList.add('flash');
  window.setTimeout(() => el.classList.remove('flash'), 1400);
}

export function jumpTo(id: string, block: ScrollLogicalPosition): void {
  flashElement(document.getElementById(id), block);
}

/** The rendered diff row for a line, new side first, old side for deletions. */
export function lineRow(file: string, line: number): Element | null {
  const path = CSS.escape(file);
  return (
    document.querySelector(`tr.line[data-scope="review"][data-file="${path}"][data-new="${line}"]`) ??
    document.querySelector(`tr.line[data-scope="review"][data-file="${path}"][data-old="${line}"]`)
  );
}
