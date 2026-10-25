import { useEffect, useState } from "react";
import { type Agent, isAgent } from "../shared/model";

export type Route =
  | { page: "sessions" }
  | { page: "session"; agent: Agent; id: string; agentId: string | null; focus: string | null }
  | { page: "annotations" };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart, queryPart] = raw.split("?", 2);
  const parts = (pathPart ?? "").split("/").filter((p) => p.length > 0);
  const query = new URLSearchParams(queryPart ?? "");
  if (parts[0] === "annotations") return { page: "annotations" };
  if (parts[0] === "s" && parts[1] && isAgent(parts[1]) && parts[2]) {
    const agentId = parts[3] === "sub" && parts[4] ? decodeURIComponent(parts[4]) : null;
    return {
      page: "session",
      agent: parts[1],
      id: decodeURIComponent(parts[2]),
      agentId,
      focus: query.get("a"),
    };
  }
  return { page: "sessions" };
}

export function routeToHash(route: Route): string {
  switch (route.page) {
    case "sessions":
      return "#/";
    case "annotations":
      return "#/annotations";
    case "session": {
      let hash = `#/s/${route.agent}/${encodeURIComponent(route.id)}`;
      if (route.agentId) hash += `/sub/${encodeURIComponent(route.agentId)}`;
      if (route.focus) hash += `?a=${encodeURIComponent(route.focus)}`;
      return hash;
    }
  }
}

export function navigate(route: Route): void {
  const hash = routeToHash(route);
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
