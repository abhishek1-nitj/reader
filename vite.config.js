import { defineConfig } from "vite";

const isGitHubActions = process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  base: isGitHubActions ? "/Reader/" : "/"
});
