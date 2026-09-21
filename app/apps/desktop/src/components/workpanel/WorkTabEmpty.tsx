import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "../icons";

/**
 * Shared work-panel empty state. Matches the proportions the rest of the app
 * already uses for empty states (`.ext-empty`, `.projects-empty`): a tiled
 * icon, a title, optional supporting copy, and optional entry points below.
 */
export function WorkTabEmpty({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="work-tab-empty">
      <span className="work-tab-empty-icon" aria-hidden>
        <Icon size={18} />
      </span>
      <p className="work-tab-empty-title">{title}</p>
      {body && <p className="work-tab-empty-body">{body}</p>}
      {children}
    </div>
  );
}
