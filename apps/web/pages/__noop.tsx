// apps/web/pages/__noop.tsx
// Deliberate no-op Pages Router entry to ensure Next creates pages-manifest.json
// Does not collide with real routes and never renders in normal navigation.

export default function Noop() {
  return null;
}