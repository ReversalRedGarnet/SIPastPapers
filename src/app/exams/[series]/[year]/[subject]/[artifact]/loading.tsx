// Same convention as src/app/results/loading.tsx: shown immediately on
// navigation here, then swapped out for the real page once it's ready.
export default function Loading() {
  return (
    <>
      <h1 className="visually-hidden">Exam paper</h1>
      <p className="lede" style={{ margin: "1rem 0" }}>
        Loading…
      </p>
    </>
  );
}
