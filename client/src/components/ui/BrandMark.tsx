import "./BrandMark.scss";

interface BrandMarkProps {
  size?: number;
  className?: string;
}

// The HandOver handshake mark, filled with a left-to-right gradient from the
// accent to a 50% darker shade. The favicon is the standalone brand.svg.
export function BrandMark({ size = 22, className }: BrandMarkProps) {
  return (
    <div
      className={`brand_mark ${className}`}
      style={{ width: size, height: size }}
    >
      <img src={"/brand.svg"} alt="HandOver" />
    </div>
  );
}
