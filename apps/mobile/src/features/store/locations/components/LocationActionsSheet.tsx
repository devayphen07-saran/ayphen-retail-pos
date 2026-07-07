import { useMobileTheme } from '@ayphen/mobile-theme';
import { Column, SheetListItem, useBottomSheet } from '@ayphen/mobile-ui-components';
import type { LocationResponse } from '@ayphen/api-manager';

export interface LocationActionsSheetProps {
  location: LocationResponse;
  onEdit: (location: LocationResponse) => void;
  onSetDefault: (locationId: string) => void;
  onDelete: (location: LocationResponse) => void;
}

export function LocationActionsSheet({ location, onEdit, onSetDefault, onDelete }: LocationActionsSheetProps) {
  const { theme } = useMobileTheme();
  const sheet = useBottomSheet();
  return (
    <Column gap={theme.sizing.small} style={{ paddingVertical: theme.sizing.small }}>
      <SheetListItem
        label="Edit"
        icon="Pencil"
        onPress={() => {
          sheet.close();
          onEdit(location);
        }}
      />
      {!location.is_default && (
        <SheetListItem
          label="Set as default"
          icon="Star"
          onPress={() => {
            sheet.close();
            onSetDefault(location.id);
          }}
        />
      )}
      {!location.is_primary && (
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