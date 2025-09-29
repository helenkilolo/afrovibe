interface Theme {
  "color-scheme": string
  "--color-base-100": string
  "--color-base-200": string
  "--color-base-300": string
  "--color-base-content": string
  "--color-primary": string
  "--color-primary-content": string
  "--color-secondary": string
  "--color-secondary-content": string
  "--color-accent": string
  "--color-accent-content": string
  "--color-neutral": string
  "--color-neutral-content": string
  "--color-info": string
  "--color-info-content": string
  "--color-success": string
  "--color-success-content": string
  "--color-warning": string
  "--color-warning-content": string
  "--color-error": string
  "--color-error-content": string
  "--radius-selector": string
  "--radius-field": string
  "--radius-box": string
  "--size-selector": string
  "--size-field": string
  "--border": string
  "--depth": string
  "--noise": string
}


interface Themes {
  wireframe: Theme
  cmyk: Theme
  synthwave: Theme
  valentine: Theme
  lemonade: Theme
  winter: Theme
  business: Theme
  bumblebee: Theme
  cyberpunk: Theme
  acid: Theme
  forest: Theme
  halloween: Theme
  dim: Theme
  dark: Theme
  corporate: Theme
  nord: Theme
  caramellatte: Theme
  silk: Theme
  sunset: Theme
  coffee: Theme
  pastel: Theme
  garden: Theme
  retro: Theme
  lofi: Theme
  cupcake: Theme
  night: Theme
  autumn: Theme
  light: Theme
  black: Theme
  dracula: Theme
  abyss: Theme
  emerald: Theme
  luxury: Theme
  aqua: Theme
  fantasy: Theme
  [key: string]: Theme
}

declare const themes: Themes
export default themes