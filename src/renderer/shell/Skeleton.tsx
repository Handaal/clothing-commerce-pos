// Shimmer placeholders shown while a desk's data loads, instead of a bare "Loading…" line. The bars
// are decorative; the wrapper announces the loading state to assistive tech.

export function SkeletonLines({
  lines = 4,
  label = "Loading",
}: {
  lines?: number;
  label?: string;
}) {
  return (
    <div className="skeleton-block" role="status" aria-label={label}>
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className="skeleton skeleton-line"
          aria-hidden="true"
          style={{ width: `${Math.max(40, 92 - index * 9)}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 5,
  cols = 4,
  label = "Loading",
}: {
  rows?: number;
  cols?: number;
  label?: string;
}) {
  return (
    <div className="skeleton-table" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="skeleton-row" aria-hidden="true">
          {Array.from({ length: cols }).map((_, colIndex) => (
            <div
              key={colIndex}
              className="skeleton skeleton-line"
              style={{ flex: colIndex === 0 ? 2.4 : 1 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
