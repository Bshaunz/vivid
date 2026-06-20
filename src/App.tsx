import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { BottomNav } from "@/components/BottomNav";
import { SkeletonBlock } from "@/components/Skeleton";

/**
 * App shell. A fixed-height flex column: a scrollable content area owns the
 * viewport, the bottom nav sits beneath it. Screens fill the content area with
 * h-full — the log forms keep their single-viewport, pinned-submit behaviour
 * while Home/Pillars scroll within it.
 *
 * Routes are lazy so the heavy chart code (recharts, Home/Pillars) splits into
 * its own chunk and never weighs down the fast log-entry path.
 */
const Home = lazy(() => import("@/screens/Home"));
const Pillars = lazy(() => import("@/screens/Pillars"));
const Log = lazy(() => import("@/screens/Log"));
const Goals = lazy(() => import("@/screens/Goals"));
const AISynthesis = lazy(() => import("@/screens/AISynthesis"));
const Settings = lazy(() => import("@/screens/Settings"));

function RouteFallback() {
  return (
    <div className="mx-auto flex max-w-[390px] flex-col gap-4 px-5 pt-6">
      <SkeletonBlock className="h-10 w-32" />
      <SkeletonBlock className="h-40 w-full" />
    </div>
  );
}

export default function App() {
  return (
    <div className="flex h-dvh flex-col">
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/pillars" element={<Pillars />} />
            <Route path="/log" element={<Log />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/ai" element={<AISynthesis />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </main>
      <BottomNav />
    </div>
  );
}
