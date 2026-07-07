import { useMobileTheme } from '@ayphen/mobile-theme';
import { LucideIcon, Row, Typography } from '@ayphen/mobile-ui-components';

export function TrustItem({ iconName, label }: { iconName: 'RefreshCw' | 'ShieldCheck' | 'Receipt'; label: string }) {
  const { theme } = useMobileTheme();
  return (
    <Row align="center" gap={4}>
      <LucideIcon name={iconName} size={13} color={theme.colorTextSecondary} />
      <Typography.Caption type="secondary">{label}</Typography.Caption>
    </Row>
  );
}
