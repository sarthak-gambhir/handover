import "./Skeleton.scss";

export function Skeleton({
  height = 16,
  width,
}: {
  height?: number;
  width?: number | string;
}) {
  return (
    <span className="skeleton" style={{ height, width: width ?? "100%" }} />
  );
}
