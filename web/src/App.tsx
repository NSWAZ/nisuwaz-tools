import { useEffect, useRef, type ComponentType } from "react";
import { usePath } from "./lib/router";
import Hub from "./pages/Hub";
import Plex from "./pages/Plex";
import Fridge from "./pages/Fridge";
import NotFound from "./pages/NotFound";

const ROUTES: Record<string, ComponentType> = {
  "/": Hub,
  "/plex": Plex,
  "/fridge": Fridge,
};

export default function App() {
  const path = usePath();
  const Page = ROUTES[path] ?? NotFound;
  const first = useRef(true);

  // After an in-app navigation, move focus to the new page's heading so
  // keyboard and screen-reader users start at the top of the new page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [path]);

  return <Page />;
}
