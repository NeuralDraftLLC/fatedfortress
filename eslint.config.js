export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/coverage/**"],
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },
];