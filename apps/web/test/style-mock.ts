/**
 * CSS module stand-in.
 *
 * Returns the property name, so `styles.submit` is the string "submit" and a
 * test can assert that a component applied a class without jest having to parse
 * the stylesheet.
 */
export default new Proxy(
  {},
  {
    get: (_target, property: string) => property,
  },
);
