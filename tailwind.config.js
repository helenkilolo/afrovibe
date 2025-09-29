/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./views/**/*.{ejs,html}",
    "./views/partials/**/*.{ejs,html}",
    "./public/**/*.js",
    "./public/**/*.html",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      // These are for Tailwind utilities like bg-primary, text-secondary, etc.
      colors: {
        primary:   '#FF6B6B', // red
        secondary: '#4ECDC4', // teal
        accent:    '#FECA57', // yellow-orange
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('@tailwindcss/forms'),
    require('@tailwindcss/line-clamp'),
    require('@tailwindcss/aspect-ratio'),
    require('daisyui'),
  ], // <-- comma WAS missing here
  daisyui: {
    themes: [
      {
        afro: {
          primary:   "#FF6B6B",
          secondary: "#4ECDC4",
          accent:    "#FECA57",
          neutral:   "#1f2937",
          "base-100":"#ffffff",
          info:      "#3abff8",
          success:   "#36d399",
          warning:   "#fbbd23",
          error:     "#f87272",
        }
      },
      "cupcake",
      "light",
      "bumblebee"
    ],
    base: true,
    styled: true,
    utils: true,
  },
};
