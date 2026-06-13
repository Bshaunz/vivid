import { NavLink } from "react-router-dom";

/**
 * Bottom nav (§8): Home · Pillars · [Log] · Goals · AI. Log is the centre,
 * visually distinct (filled grey circle). Active state = white text on the
 * grey neutral token; inactive dims. No blue anywhere — AI is just a label
 * until its synthesis cards exist.
 */

export function BottomNav() {
  return (
    <nav
      className="flex shrink-0 items-stretch border-t border-card-border bg-bg"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <NavItem to="/" label="Home" end />
      <NavItem to="/pillars" label="Pillars" />
      <LogButton />
      <NavItem to="/goals" label="Goals" />
      <NavItem to="/ai" label="AI" />
    </nav>
  );
}

function NavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex flex-1 items-center justify-center py-3 text-[11px] font-semibold uppercase tracking-[0.1em] ${
          isActive ? "text-white" : "text-white/40"
        }`
      }
    >
      {label}
    </NavLink>
  );
}

function LogButton() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <NavLink
        to="/log"
        aria-label="Log"
        className={({ isActive }) =>
          `flex h-12 w-12 items-center justify-center rounded-full border text-xl font-bold ${
            isActive ? "border-accent bg-accent text-white" : "border-card-border bg-card text-white/70"
          }`
        }
      >
        +
      </NavLink>
    </div>
  );
}
