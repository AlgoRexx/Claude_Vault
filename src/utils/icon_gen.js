const { nativeImage } = require('electron');

/**
 * DG-036: Menu bar icon is a 5×5 pixel-grid mark.
 * Target physical size: 19x19 points (standard for macOS).
 * @2x Physical size: 38x38 pixels.
 * @2x Cell size: 6px.
 * @2x Gap size: 2px.
 * Total @2x = (5 * 6) + (4 * 2) = 38px.
 */
function generateTrayIcon(hasBadge = false) {
    const size = 38; // @2x size
    const cellSize = 6;
    const gap = 2;
    
    // BGRA byte order for macOS
    const coral = { b: 53, g: 75, r: 255, a: 255 };
    const transparent = { b: 0, g: 0, r: 0, a: 0 };
    
    const buffer = Buffer.alloc(size * size * 4);
    
    const activeCells = [
        [0, 2], [1, 1], [1, 3], [2, 0], [2, 4], [3, 1], [3, 3], [4, 2]
    ];

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            
            const cellX = Math.floor(x / (cellSize + gap));
            const cellY = Math.floor(y / (cellSize + gap));
            const innerX = x % (cellSize + gap);
            const innerY = y % (cellSize + gap);

            let color = transparent;

            // Diamond Grid
            if (innerX < cellSize && innerY < cellSize && cellX < 5 && cellY < 5) {
                if (activeCells.some(([r, c]) => r === cellY && c === cellX)) {
                    color = coral;
                }
            }

            // DG-037: 6pt (12px @2x) coral square badge at top-right
            // Position: 3pt (6px @2x) from top and right edges
            if (hasBadge) {
                const badgeSize = 12;
                const offset = 6;
                if (x >= (size - badgeSize - offset) && x < (size - offset) && 
                    y >= offset && y < (offset + badgeSize)) {
                    color = coral;
                }
            }

            buffer[idx] = color.b;
            buffer[idx + 1] = color.g;
            buffer[idx + 2] = color.r;
            buffer[idx + 3] = color.a;
        }
    }

    // Direct fix: The buffer is 38x38, so width/height must be 38. 
    // We pass scaleFactor: 2.0 to tell Electron it represents a 19pt icon.
    return nativeImage.createFromBitmap(buffer, { width: 38, height: 38, scaleFactor: 2.0 });
}

module.exports = { generateTrayIcon };
