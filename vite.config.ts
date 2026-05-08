import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";
const isUserOrOrgSite = repoName?.endsWith(".github.io");

export default defineConfig({
  base: isGitHubPagesBuild && repoName && !isUserOrOrgSite ? `/${repoName}/` : "/",
  plugins: [react()],
});
