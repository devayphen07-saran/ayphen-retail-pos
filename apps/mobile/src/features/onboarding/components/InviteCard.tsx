import { memo } from 'react';
import styled from 'styled-components/native';
import { Button, ListRow, Row } from '@ayphen/mobile-ui-components';
import type { MyInvitationResponse } from '@ayphen/api-manager';

interface InviteCardProps {
  invite: MyInvitationResponse;
  busy: boolean;
  onAccept: (invite: MyInvitationResponse) => void;
  onReject: (invite: MyInvitationResponse) => void;
}

export const InviteCard = memo(function InviteCard({ invite, busy, onAccept, onReject }: InviteCardProps) {
  return (
    <CardContainer style={busy ? { opacity: 0.5 } : undefined}>
      <ListRow
        icon="Store"
        title={invite.store_name}
        subtitle={`Invited as ${invite.role_name}`}
        chevron={false}
      />
      <Row gap={8}>
        <Button
          label="Decline"
          variant="dashed"
          disabled={busy}
          onPress={() => onReject(invite)}
          accessibilityLabel={`Decline invitation to ${invite.store_name}`}
          style={{ flex: 1 }}
        />
        <Button
          label="Accept"
          variant="default"
          disabled={busy}
          onPress={() => onAccept(invite)}
          accessibilityLabel={`Accept invitation to ${invite.store_name}`}
          style={{ flex: 1 }}
        />
      </Row>
    </CardContainer>
  );
});

const CardContainer = styled.View`
  border-radius: ${({ theme }) => theme.borderRadius.large}px;
  border-width: ${({ theme }) => theme.borderWidth.thin}px;
  border-color: ${({ theme }) => theme.colorBorderSecondary};
  padding: ${({ theme }) => theme.sizing.small}px;
  gap: ${({ theme }) => theme.sizing.small}px;
`;
