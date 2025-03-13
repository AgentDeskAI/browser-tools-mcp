module.exports = {
  root: false,
  extends: ['../.eslintrc.js'],
  globals: {
    chrome: 'readonly',
  },
  env: {
    browser: true,
    node: true,
    es6: true,
  },
};
