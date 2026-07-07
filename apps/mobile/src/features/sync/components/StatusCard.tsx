import { useMobileTheme } from '@ayphen/mobile-theme';
import { Card, LucideIcon, type LucideIconNameType, Row, Typography } from '@ayphen/mobile-ui-components';

/** "All clear" / informational row for a section with nothing to show —
 *  a tinted icon + line instead of bare floating caption text, so an empty
 *  state still reads as a deliberate, reassuring result rather than a gap
 *  in the layout. */
export function StatusCard({
  icon,
  tone,
  text,
}: {
  icon: LucideIconNameType;
  tone: 'success' | 'info';
  text: string;
}) {
  const { theme } = useMobileTheme();
  const color = tone === 'success' ? theme.color.success.main : theme.color.blue.main;
  const bg = tone === 'success' ? theme.color.success.bg : theme.color.blue.bg;
  return (
    <Card bordered={false} backgroundColor={bg} padding="small">
      <Row align="center" gap={10}>
        <LucideIcon name={icon} size={18} color={color} />
        <Typography.Caption type="secondary" style={{ flex: 1 }}>
          {text}
        </Typography.Caption>
      </Row>
    </Card>
  );
}
