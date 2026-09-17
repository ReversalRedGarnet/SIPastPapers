// This whole file is a "component": a small, reusable, named piece of a
// page's design -- here, a colored pill-shaped label. Once defined, other
// files can use it like a custom HTML tag, e.g. writing
// `<Badge tone="good">Published</Badge>`, instead of repeating the same
// `<span>` and CSS class combination everywhere a badge is needed.
// `children` is a special prop name React reserves for whatever is written
// between a component's opening and closing tags -- here, "Published"
// would become `children`. `React.ReactNode` is the type for "anything
// that's valid to put on a page": text, numbers, other components, etc.
export function Badge({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: React.ReactNode;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
