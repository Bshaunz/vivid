/**
 * Loading skeletons — pure-black background, card-grey blocks, a subtle pulse.
 * No new colors: only bg/card/border tokens. Used while live queries resolve.
 */

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-[14px] bg-card ${className}`} />;
}

/** Full-screen log skeleton matching the 390px single-viewport log layout. */
export function LogSkeleton({ title }: { title: string }) {
  return (
    <main className="mx-auto flex h-dvh max-w-[390px] flex-col gap-5 px-5 pb-5 pt-6">
      <header>
        <SkeletonBlock className="h-3 w-24" />
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-white/80">{title}</h1>
      </header>
      <SkeletonBlock className="h-20 w-full" />
      <SkeletonBlock className="h-16 w-full" />
      <div className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-14 rounded-[8px]" />
        ))}
      </div>
      <SkeletonBlock className="mt-auto h-16 w-full" />
    </main>
  );
}
