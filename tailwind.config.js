// Build with npm run build:css. Stay on v3 unless the page is checked for styling changes.
module.exports = {
  content: ['./public/index.html', './public/app.js'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#111827' // near black
        },
        secondary: {
          DEFAULT: '#6B7280' // neutral gray
        },
        surface: {
          DEFAULT: '#F9FAFB', // subtle off-white background
          muted: '#F3F4F6'
        }
      },
      boxShadow: {
        soft: '0 10px 30px -12px rgba(0,0,0,0.15)'
      }
    }
  }
};
