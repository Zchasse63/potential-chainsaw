// Tailwind mapping for the Kelo token contract. The ONLY values allowed here
// are var(--kelo-*) references into src/styles/tokens.css (copied from
// docs/design/tokens.css, canonical) — feature code consumes these semantic
// classes and never raw hex or arbitrary bracket values (ESLint guardrail 3).
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          app: "var(--kelo-surface-app)",
          card: "var(--kelo-surface-card)",
          input: "var(--kelo-surface-input)",
          inverse: "var(--kelo-surface-inverse)",
        },
        ink: {
          DEFAULT: "var(--kelo-text-primary)",
          secondary: "var(--kelo-text-secondary)",
          muted: "var(--kelo-text-muted)",
          placeholder: "var(--kelo-text-placeholder)",
          disabled: "var(--kelo-text-disabled)",
          "on-brand": "var(--kelo-text-on-brand)",
        },
        brand: {
          "050": "var(--kelo-brand-050)",
          100: "var(--kelo-brand-100)",
          200: "var(--kelo-brand-200)",
          300: "var(--kelo-brand-300)",
          400: "var(--kelo-brand-400)",
          500: "var(--kelo-brand-500)",
          600: "var(--kelo-brand-600)",
          700: "var(--kelo-brand-700)",
          800: "var(--kelo-brand-800)",
          900: "var(--kelo-brand-900)",
        },
        neutral: {
          "050": "var(--kelo-neutral-050)",
          100: "var(--kelo-neutral-100)",
          400: "var(--kelo-neutral-400)",
          600: "var(--kelo-neutral-600)",
        },
        birch: {
          "050": "var(--kelo-birch-050)",
          100: "var(--kelo-birch-100)",
          200: "var(--kelo-birch-200)",
          300: "var(--kelo-birch-300)",
          400: "var(--kelo-birch-400)",
          500: "var(--kelo-birch-500)",
          text: "var(--kelo-birch-text)",
        },
        success: {
          DEFAULT: "var(--kelo-success)",
          tint: "var(--kelo-success-tint)",
          "on-tint": "var(--kelo-success-on-tint)",
          border: "var(--kelo-success-border)",
        },
        warning: {
          DEFAULT: "var(--kelo-warning)",
          tint: "var(--kelo-warning-tint)",
          "on-tint": "var(--kelo-warning-on-tint)",
          border: "var(--kelo-warning-border)",
          "surface-weak": "var(--kelo-warning-surface-weak)",
          emphasis: "var(--kelo-warning-emphasis-text)",
        },
        danger: {
          DEFAULT: "var(--kelo-danger)",
          tint: "var(--kelo-danger-tint)",
          "on-tint": "var(--kelo-danger-on-tint)",
          border: "var(--kelo-danger-border)",
        },
        info: {
          DEFAULT: "var(--kelo-info)",
          tint: "var(--kelo-info-tint)",
          "on-tint": "var(--kelo-info-on-tint)",
          border: "var(--kelo-info-border)",
        },
        ai: {
          accent: "var(--kelo-ai-accent)",
          tint: "var(--kelo-ai-tint)",
          surface: "var(--kelo-ai-surface)",
          "on-tint": "var(--kelo-ai-on-tint)",
          "border-tint": "var(--kelo-ai-border-tint)",
        },
        hairline: "var(--kelo-hairline)",
        "border-strong": "var(--kelo-border-strong)",
        "input-border": "var(--kelo-border-input)",
        link: { DEFAULT: "var(--kelo-link)", hover: "var(--kelo-link-hover)" },
        selected: { bg: "var(--kelo-selected-bg)", border: "var(--kelo-selected-border)" },
        skeleton: {
          base: "var(--kelo-skeleton-base)",
          highlight: "var(--kelo-skeleton-highlight)",
        },
        "icon-inactive": "var(--kelo-icon-inactive)",
        "ghost-hover": "var(--kelo-action-ghost-hover)",
      },
      fontFamily: {
        display: "var(--kelo-font-display)",
        ui: "var(--kelo-font-ui)",
        mono: "var(--kelo-font-mono)",
      },
      fontSize: {
        // Design-guide type floor: micro mono 10.5px only for uppercase labels,
        // 12px desktop chrome, 13px dense tables, display never below 20px.
        micro: ["10.5px", { lineHeight: "14px" }],
        chrome: ["12px", { lineHeight: "16px" }],
        table: ["13px", { lineHeight: "20px" }],
        body: ["14px", { lineHeight: "20px" }],
        title: ["20px", { lineHeight: "28px" }],
        hero: ["38px", { lineHeight: "44px" }],
      },
      borderRadius: {
        1: "var(--kelo-radius-1)",
        2: "var(--kelo-radius-2)",
        3: "var(--kelo-radius-3)",
        4: "var(--kelo-radius-4)",
        desk: "var(--kelo-radius-desk)",
        full: "var(--kelo-radius-full)",
        "status-processing": "var(--kelo-radius-status-processing)",
        "status-failed": "var(--kelo-radius-status-failed)",
        "critical-dot": "var(--kelo-radius-status-critical-dot)",
      },
      width: {
        rail: "232px", // design guide §8 owner-desktop sidebar
      },
      boxShadow: {
        1: "var(--kelo-shadow-1)",
        2: "var(--kelo-shadow-2)",
        3: "var(--kelo-shadow-3)",
      },
      transitionDuration: {
        1: "var(--kelo-duration-1)",
        2: "var(--kelo-duration-2)",
        3: "var(--kelo-duration-3)",
      },
    },
  },
  plugins: [],
};
