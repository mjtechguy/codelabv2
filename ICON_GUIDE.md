# Extension Icon Configuration

## Current Icon Setup
The extension is configured to use an icon at `icons/codelab-icon.png` in the package.json.

## Icon Requirements
- **Format**: PNG (recommended) or SVG
- **Size**: 256x256 pixels (will be scaled down as needed)
- **Background**: Transparent background recommended
- **File Location**: `/icons/codelab-icon.png`

## To Add Your Icon

### Option 1: Create a PNG Icon
1. Create or obtain a 256x256 PNG image with transparent background
2. Save it as `icons/codelab-icon.png`
3. The extension will use this icon in the VS Code marketplace and extension list

### Option 2: Use the Existing SVG
1. Rename the existing `icons/mdcl-icon.svg` to `icons/codelab-icon.svg`
2. Update package.json to use SVG:
   ```json
   "icon": "icons/codelab-icon.svg"
   ```

### Option 3: Create a Custom Icon
You can create a simple icon using:
- **Online Tools**:
  - https://www.canva.com (free with templates)
  - https://www.figma.com (free design tool)
  - https://vectr.com (free vector graphics editor)
- **Icon Ideas**:
  - A terminal/console with a play button
  - Code brackets `< >` with a play arrow
  - "CL" letters stylized
  - A lab beaker with code symbols

## Icon Best Practices
- Keep it simple and recognizable at small sizes
- Use colors that work on both light and dark backgrounds
- Avoid too much detail that won't be visible when scaled down
- Consider using your brand colors if you have them

## Testing Your Icon
After adding your icon:
1. Run `./build.sh` to rebuild the extension
2. Install the VSIX to see how it looks in VS Code
3. The icon appears in:
   - Extensions sidebar
   - Extension details page
   - VS Code marketplace (when published)