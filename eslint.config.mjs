import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  // design/ holds hi-fi mockups and throwaway Playwright scratch scripts, not app code.
  { ignores: ["design/**"] },
  ...nextVitals,
  ...nextTs,
];

export default config;
