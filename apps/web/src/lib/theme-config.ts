/**
 * Theme vocabulary shared by the browser provider and the inline boot script.
 *
 * Kept out of `theme.tsx` because the root layout is a server component and
 * needs the storage key to build the pre-paint script. A `'use client'` module
 * cannot provide that value at render time.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'renderflow-theme';
