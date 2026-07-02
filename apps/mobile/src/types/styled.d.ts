import 'styled-components/native';
import type { NKSTheme } from '@nks/mobile-theme';

declare module 'styled-components/native' {
  export interface DefaultTheme extends NKSTheme {}
}
