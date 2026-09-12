/**
 * The Alfin wordmark: the name in lowercase, with the dot on the i in the
 * ledger green the app uses for "posted, done, sure". The i is a dotless
 * ı (U+0131) so the dot can be drawn where we want it and in the colour we
 * want; screen readers get the plain word through aria-label.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`.trim()} aria-label="Alfin" role="img">
      <span aria-hidden="true">
        alf<span className="wordmark-i">ı</span>n
      </span>
    </span>
  );
}
