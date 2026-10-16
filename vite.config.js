import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

// Vite treats each HTML file as a build entry, but only discovers index.html on
// its own. Every other page has to be listed here or it never reaches dist/ —
// and the deploy (Azure Static Web Apps, output_location: "dist") serves dist/
// verbatim, so a missing entry is a 404 in production while `npm run dev`
// happily serves it from source. Add new top-level pages to this list.
const pages = ['index', 'help', 'rules', 'globals', 'disclaimer', 'about'];

export default defineConfig({
    plugins: [
        tailwindcss(),
    ],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: Object.fromEntries(
                pages.map(name => [name, resolve(import.meta.dirname, `${name}.html`)]),
            ),
        },
    },
    test: {
        // Vitest's own two exclusions, plus agent worktrees: each one under
        // .claude/worktrees/ is a whole copy of the repo, suites included, so
        // without this a run here runs and counts every copy.
        exclude: ['**/node_modules/**', '**/.git/**', '.claude/**'],
    },
});
