/**
 * On-brand empty state for screens that ship in later build steps (Goals →
 * step 13, AI → step 10, Settings → step 14). Pure black, grey chrome, no blue.
 */
export default function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <main className="mx-auto flex h-full max-w-[390px] flex-col px-5 pb-5 pt-6">
      <header>
        <p className="label">VIVID</p>
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="h-12 w-12 rounded-full border border-card-border bg-card" />
        <p className="max-w-[260px] text-sm text-white/40">{note}</p>
      </div>
    </main>
  );
}
