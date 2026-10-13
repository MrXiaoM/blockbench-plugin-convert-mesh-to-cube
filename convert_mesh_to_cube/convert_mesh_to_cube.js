/**
 * Convert Mesh to Cube - V10
 * 
 * 核心策略：找到每个方向上面积最大的三角形对，使用它们的 UV
 * 因为原始 mesh 的一个面可能由多个三角形组成，映射到纹理的不同区域
 * 我们选择覆盖面积最大的那对三角形的 UV
 */

let convert_button;
let remove_unused_textures_button;

Plugin.register('convert_mesh_to_cube', {
    title: 'Convert Mesh to Cube',
    author: 'MrXiaoM (V10)', //b919 fix not adding myself in credits that's original author desition
    icon: 'fa-cube',
    description: 'Convert mesh back to cube - preserves transformed placement and largest triangle pair UV.',
    tags: ['Mesh', 'Cube', 'Tool'],
    version: '10.0.0',
    variant: 'both',
    onload() {
        Language.addTranslations('en', {
            "action.convert_mesh_to_cube": "Convert to Cube",
            "action.convert_mesh_to_cube.desc": "Convert the selected elements into cubes",
            "action.remove_unused_textures": "Remove Unused Textures",
            "action.remove_unused_textures.desc": "Remove all textures that are not used by the current model",
        });
        Language.addTranslations('zh', {
            "action.convert_mesh_to_cube": "转换成块",
            "action.convert_mesh_to_cube.desc": "转换使选中的元素成块",
            "action.remove_unused_textures": "移除未使用纹理",
            "action.remove_unused_textures.desc": "移除当前模型未被使用的所有纹理",
        });

        function collectUsedTextureIds() {
            const usedTextureIds = new Set();
            Outliner.elements.forEach(element => {
                if (!element.faces) return;
                Object.values(element.faces).forEach(face => {
                    if (!face || !face.texture || face.texture === null) return;
                    usedTextureIds.add(face.texture);
                });
            });
            return usedTextureIds;
        }

        function isTextureUsed(texture, usedTextureIds) {
            return usedTextureIds.has(texture.uuid)
                || usedTextureIds.has(texture.id)
                || usedTextureIds.has(`#${texture.id}`)
                || usedTextureIds.has(texture);
        }
 
        convert_button = new Action('convert_mesh_to_cube', {
            icon: 'fa-cube',
            category: 'edit',
            condition: { modes: ['edit'], features: ['meshes'], method: () => (Mesh.selected.length) },
            click() {
                Undo.initEdit({ elements: [...Mesh.selected], outliner: true });

                const EPSILON = 1e-4;
                function approxEqual(a, b) { return Math.abs(a - b) < EPSILON; }
                function normalizeBounds(value) { return Math.abs(value) < EPSILON ? 0 : value; }
                function triangleArea3D(p1, p2, p3) {
                    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
                    const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
                    const cx = ay * bz - az * by;
                    const cy = az * bx - ax * bz;
                    const cz = ax * by - ay * bx;
                    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
                }

                let new_cubes = [];
                const selected_meshes = [...Mesh.selected];

                selected_meshes.forEach(mesh => {
                    const localVertices = Object.values(mesh.vertices);
                    if (!localVertices.length) return;

                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    let minZ = Infinity, maxZ = -Infinity;

                    localVertices.forEach(coord => {
                        minX = Math.min(minX, coord[0]); maxX = Math.max(maxX, coord[0]);
                        minY = Math.min(minY, coord[1]); maxY = Math.max(maxY, coord[1]);
                        minZ = Math.min(minZ, coord[2]); maxZ = Math.max(maxZ, coord[2]);
                    });

                    minX = normalizeBounds(minX);
                    maxX = normalizeBounds(maxX);
                    minY = normalizeBounds(minY);
                    maxY = normalizeBounds(maxY);
                    minZ = normalizeBounds(minZ);
                    maxZ = normalizeBounds(maxZ);

                    const faceDetectors = {
                        east: (coords) => coords.every(c => approxEqual(c[0], maxX)),
                        west: (coords) => coords.every(c => approxEqual(c[0], minX)),
                        up: (coords) => coords.every(c => approxEqual(c[1], maxY)),
                        down: (coords) => coords.every(c => approxEqual(c[1], minY)),
                        south: (coords) => coords.every(c => approxEqual(c[2], maxZ)),
                        north: (coords) => coords.every(c => approxEqual(c[2], minZ))
                    };

                    // Corner positions indexed exactly like vertex_keys in Blockbench's
                    // Cube -> Mesh conversion (mesh_editing.js convert_to_mesh).
                    const vertexKeysPos = [
                        [maxX, maxY, maxZ],
                        [maxX, maxY, minZ],
                        [maxX, minY, maxZ],
                        [maxX, minY, minZ],
                        [minX, maxY, maxZ],
                        [minX, maxY, minZ],
                        [minX, minY, maxZ],
                        [minX, minY, minZ]
                    ];
                    // Per-direction vertex order passed to addFace in convert_to_mesh.
                    const convertOrder = {
                        east: [1, 0, 3, 2],
                        west: [4, 5, 6, 7],
                        up: [1, 5, 0, 4],
                        down: [2, 6, 3, 7],
                        south: [0, 4, 2, 6],
                        north: [5, 1, 7, 3]
                    };

                    const faceData = {
                        north: null, south: null, east: null, west: null, up: null, down: null
                    };

                    mesh.forAllFaces((face) => {
                        const uniqueVkeys = [...new Set(face.vertices)];
                        if (uniqueVkeys.length < 3) return;

                        const entries = uniqueVkeys
                            .filter(vkey => mesh.vertices[vkey] && face.uv && face.uv[vkey])
                            .map(vkey => ({ coord: mesh.vertices[vkey], uv: face.uv[vkey].slice() }));
                        if (entries.length < 3) return;

                        const faceCoords = entries.map(entry => entry.coord);
                        let direction = null;
                        for (const [dir, detector] of Object.entries(faceDetectors)) {
                            if (detector(faceCoords)) {
                                direction = dir;
                                break;
                            }
                        }
                        if (!direction) return;

                        const area = triangleArea3D(faceCoords[0], faceCoords[1], faceCoords[2]);
                        if (area <= EPSILON) return;

                        const current = faceData[direction];
                        if (!current || area > current.area) {
                            faceData[direction] = { entries, texture: face.texture, area };
                        }
                    });

                    function matchEntryUV(entries, target) {
                        for (const entry of entries) {
                            if (approxEqual(entry.coord[0], target[0])
                                && approxEqual(entry.coord[1], target[1])
                                && approxEqual(entry.coord[2], target[2])) {
                                return entry.uv;
                            }
                        }
                        return null;
                    }

                    // Inverts Blockbench's Cube -> Mesh UV assignment (mesh_editing.js addFace),
                    // recovering the cube face rect [u1, v1, u2, v2] and its rotation so that
                    // re-running "Convert to Mesh" reproduces the same per-vertex UVs.
                    function solveFaceUV(direction, entries) {
                        const corners = convertOrder[direction].map(index => vertexKeysPos[index]);
                        const R = [
                            matchEntryUV(entries, corners[1]),
                            matchEntryUV(entries, corners[0]),
                            matchEntryUV(entries, corners[2]),
                            matchEntryUV(entries, corners[3])
                        ];
                        if (R.some(uv => !uv)) return null;

                        if (approxEqual(R[1][1], R[0][1]) && approxEqual(R[2][0], R[1][0]) && approxEqual(R[3][0], R[0][0]) && approxEqual(R[3][1], R[2][1])) {
                            return { uv: [R[0][0], R[0][1], R[1][0], R[2][1]], rotation: 0 };
                        }
                        if (approxEqual(R[0][0], R[1][0]) && approxEqual(R[2][1], R[1][1]) && approxEqual(R[3][0], R[2][0]) && approxEqual(R[3][1], R[0][1])) {
                            return { uv: [R[1][0], R[1][1], R[2][0], R[0][1]], rotation: 90 };
                        }
                        if (approxEqual(R[0][1], R[1][1]) && approxEqual(R[1][0], R[2][0]) && approxEqual(R[3][0], R[0][0]) && approxEqual(R[3][1], R[2][1])) {
                            return { uv: [R[2][0], R[2][1], R[0][0], R[0][1]], rotation: 180 };
                        }
                        if (approxEqual(R[1][1], R[2][1]) && approxEqual(R[0][0], R[1][0]) && approxEqual(R[3][0], R[2][0]) && approxEqual(R[3][1], R[0][1])) {
                            return { uv: [R[3][0], R[3][1], R[0][0], R[1][1]], rotation: 270 };
                        }
                        return null;
                    }

                    const computedFaces = {};
                    for (const [direction, data] of Object.entries(faceData)) {
                        if (!data) {
                            computedFaces[direction] = { uv: [0, 0, 16, 16], texture: null, rotation: 0 };
                            continue;
                        }

                        const solved = solveFaceUV(direction, data.entries);
                        if (solved) {
                            computedFaces[direction] = { uv: solved.uv, texture: data.texture, rotation: solved.rotation };
                        } else {
                            const uValues = data.entries.map(entry => entry.uv[0]);
                            const vValues = data.entries.map(entry => entry.uv[1]);
                            computedFaces[direction] = {
                                uv: [Math.min(...uValues), Math.min(...vValues), Math.max(...uValues), Math.max(...vValues)],
                                texture: data.texture,
                                rotation: 0
                            };
                        }
                    }

                    // Mesh rotation is stored in the THREE default 'XYZ' order (Blockbench's
                    // Cube -> Mesh conversion reorders Format.euler_order to 'XYZ'). Cubes render
                    // with Format.euler_order, so reorder back to preserve the visual orientation.
                    // This is the inverse of mesh_editing.js convert_to_mesh (lines 545-547).
                    let cube_rotation = [0, 0, 0];
                    if (mesh.rotation) {
                        const rotation_euler = new THREE.Euler(0, 0, 0, 'XYZ').fromArray(mesh.rotation.map(Math.degToRad));
                        rotation_euler.reorder(Format.euler_order || 'ZYX');
                        cube_rotation = rotation_euler.toArray().map(r => Math.roundTo(Math.radToDeg(r), 4));
                    }

                    const cube = new Cube({
                        name: mesh.name,
                        color: mesh.color,
                        origin: mesh.origin ? mesh.origin.slice() : [0, 0, 0],
                        rotation: cube_rotation,
                        box_uv: false,
                        autouv: 0,
                        from: [minX + mesh.origin[0], minY + mesh.origin[1], minZ + mesh.origin[2]],
                        to: [maxX + mesh.origin[0], maxY + mesh.origin[1], maxZ + mesh.origin[2]],
                        faces: {
                            north: { uv: computedFaces.north.uv, texture: computedFaces.north.texture, rotation: computedFaces.north.rotation },
                            south: { uv: computedFaces.south.uv, texture: computedFaces.south.texture, rotation: computedFaces.south.rotation },
                            east: { uv: computedFaces.east.uv, texture: computedFaces.east.texture, rotation: computedFaces.east.rotation },
                            west: { uv: computedFaces.west.uv, texture: computedFaces.west.texture, rotation: computedFaces.west.rotation },
                            up: { uv: computedFaces.up.uv, texture: computedFaces.up.texture, rotation: computedFaces.up.rotation },
                            down: { uv: computedFaces.down.uv, texture: computedFaces.down.texture, rotation: computedFaces.down.rotation }
                        }
                    });

                    cube.sortInBefore(mesh).init();
                    new_cubes.push(cube);
                    selected.push(cube);
                    mesh.remove();
                });

                Undo.finishEdit('Convert elements to cubes', { elements: new_cubes, outliner: true });
                Canvas.updateView({ elements: selected_meshes, element_aspects: { geometry: true, transform: true }, selection: true });
                Canvas.updateView({ elements: new_cubes, element_aspects: { geometry: true, transform: true }, selection: true });
                updateSelection();
            }
        });

        remove_unused_textures_button = new Action('remove_unused_textures', {
            icon: 'fa-trash',
            category: 'tools',
            condition: () => (Texture.all && Texture.all.length > 0),
            click() {
                const usedTextureIds = collectUsedTextureIds();
                const unusedTextures = Texture.all.filter(texture => !isTextureUsed(texture, usedTextureIds));
                if (!unusedTextures.length) {
                    Blockbench.showQuickMessage('没有可移除的未使用纹理');
                    return;
                }

                Undo.initEdit({ textures: [...unusedTextures] });
                unusedTextures.forEach(texture => texture.remove());
                Undo.finishEdit('Remove unused textures');
                Blockbench.showQuickMessage(`已移除 ${unusedTextures.length} 个未使用纹理`);
            }
        });
 
        // 添加到菜单 / Add to menu
        MenuBar.addAction(convert_button, 'mesh');
        MenuBar.addAction(remove_unused_textures_button, 'tools');
        var meshMenu = Mesh.prototype.menu.structure;
        var index = meshMenu.indexOf("apply_mesh_rotation");
        meshMenu.splice(index + 1, 0, convert_button.id);
    },
    onunload() {
        convert_button.delete();
        remove_unused_textures_button.delete();
    }
});
