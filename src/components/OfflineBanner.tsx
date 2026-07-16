interface Props {
  onRetry: () => void;
}

export function OfflineBanner({ onRetry }: Props) {
  return (
    <div className="banner">
      <span>Can't reach the shared khata. Check your connection.</span>
      <button className="link" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
