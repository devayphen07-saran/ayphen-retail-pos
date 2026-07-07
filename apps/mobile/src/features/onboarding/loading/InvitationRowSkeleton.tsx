import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';

/** Matches ListRow's shape (icon slot + title + subtitle) so there's zero
 *  layout shift when data replaces the skeleton (loading-agent.md §2). Used
 *  per-slot by InvitationsScreen's ListScaffold loader. */
export function InvitationRowSkeleton() {
  return (
    <Row align="center" gap={12} padding="xSmall">
      <SkeletonBox width={40} height={40} borderRadius={20} />
      <Column flex={1} gap={6}>
        <SkeletonBox width="58%" height={13} />
        <SkeletonBox width="36%" height={10} />
      </Column>
    </Row>
  );
}
