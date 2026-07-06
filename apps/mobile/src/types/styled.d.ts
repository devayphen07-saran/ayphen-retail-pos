import 'styled-components/native';
import type { MobileTheme } from '@ayphen/mobile-theme';

declare module 'styled-components/native' {
  export interface DefaultTheme extends MobileTheme {}
}
