import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A round avatar with a person's colour. The name is rendered as text, never HTML. */
export function Avatar({
  name,
  color,
  size = 24,
  className,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title ?? name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border-2 border-panel font-semibold text-white select-none",
        className,
      )}
      style={{ backgroundColor: color, width: size, height: size, fontSize: size * 0.46 }}
    >
      {initials(name)}
    </span>
  );
}
