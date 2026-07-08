import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, SheetListItem, useBottomSheet } from '@ayphen/mobile-ui-components';
import type { LocationResponse } from '@ayphen/api-manager';

export interface LocationActionsSheetProps {
  location: LocationResponse;
  onEdit: (location: LocationResponse) => void;
  onSetDefault: (locationId: string) => void;
  onDelete: (location: LocationResponse) => void;
  /** Mirrors the backend's own per-route requirement (location.controller.ts:
   *  update + setDefault both require `Location:edit`, remove requires
   *  `Location:delete`) — hide an action here rather than let it 403 after
   *  the tap. */
  canEdit: boolean;
  canDelete: boolean;
}

export function LocationActionsSheet({
  location,
  onEdit,
  onSetDefault,
  onDelete,
  canEdit,
  canDelete,
}: LocationActionsSheetProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();
  return (
    <Column gap={theme.sizing.small} style={{ paddingVertical: theme.sizing.small }}>
      {canEdit && (
        <SheetListItem
          label="Edit"
          icon="Pencil"
          onPress={() => {
            sheet.close();
            onEdit(location);
          }}
        />
      )}
      {canEdit && !location.is_default && (
        <SheetListItem
          label="Set as default"
          icon="Star"
          onPress={() => {
            sheet.close();
            onSetDefault(location.id);
          }}
        />
      )}
      {canDelete && !location.is_primary && (
        <SheetListItem
          label="Delete"
          icon="Trash2"
          destructive
          onPress={() => {
            sheet.close();
            onDelete(location);
          }}
        />
      )}
    </Column>
  );
}