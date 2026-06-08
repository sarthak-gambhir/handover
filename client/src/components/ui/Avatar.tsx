import { cx } from "../../lib/cx";
import "./Avatar.scss";

type AvatarSize = "sm" | "md" | "lg";

interface AvatarProps {
  name: string;
  size?: AvatarSize;
  // When provided, renders a presence dot in the corner.
  online?: boolean;
  className?: string;
}

const COLOR_COUNT = 6;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic colour bucket so a given name always renders the same tint.
// Class-based (no inline styles) to satisfy the production CSP.
function colorIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % COLOR_COUNT;
}

export function Avatar({ name, size = "md", online, className }: AvatarProps) {
  return (
    <span
      className={cx(
        "avatar",
        `avatar_${size}`,
        `avatar_c${colorIndex(name)}`,
        className,
      )}
      aria-hidden="true"
      title={name}
    >
      <span className="avatar_initials">{initials(name)}</span>
      {online !== undefined && (
        <span
          className={cx(
            "avatar_dot",
            online ? "avatar_dot_online" : "avatar_dot_offline",
          )}
        />
      )}
    </span>
  );
}
