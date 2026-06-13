/**
 * Convert Mesh to Cube - V8
 * 
 * 核心策略：找到每个方向上面积最大的三角形对，使用它们的 UV
 * 因为原始 mesh 的一个面可能由多个三角形组成，映射到纹理的不同区域
 * 我们选择覆盖面积最大的那对三角形的 UV
 */

let convert_button;
let remove_unused_textures_button;

Plugin.register('convert_mesh_to_cube', {
    title: 'Convert Mesh to Cube',
    author: 'MrXiaoM (V9)',
    icon: 'fa-cube',
    description: 'Convert mesh back to cube - preserves transformed placement and largest triangle pair UV.',
    tags: ['Mesh', 'Cube', 'Tool'],
    version: '9.0.0',
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

                    const faceTriangles = {
                        north: [], south: [], east: [], west: [], up: [], down: []
                    };

                    mesh.forAllFaces((face) => {
                        const faceVkeys = face.vertices;
                        const uniqueVkeys = [...new Set(faceVkeys)];
                        if (uniqueVkeys.length < 3) return;

                        const faceCoords = uniqueVkeys.map(vkey => mesh.vertices[vkey]).filter(coord => coord);
                        if (faceCoords.length < 3) return;

                        let direction = null;
                        for (const [dir, detector] of Object.entries(faceDetectors)) {
                            if (detector(faceCoords)) {
                                direction = dir;
                                break;
                            }
                        }
                        if (!direction) return;

                        const area = triangleArea3D(faceCoords[0], faceCoords[1], faceCoords[2]);
                        if (face.uv && area > EPSILON) {
                            const triangleUVs = [];
                            uniqueVkeys.forEach(vkey => {
                                if (face.uv[vkey]) {
                                    triangleUVs.push(face.uv[vkey].slice());
                                }
                            });

                            if (triangleUVs.length >= 3) {
                                faceTriangles[direction].push({
                                    uvs: triangleUVs,
                                    texture: face.texture,
                                    area: area
                                });
                            }
                        }
                    });

                    const computedFaces = {};
                    for (const [direction, triangles] of Object.entries(faceTriangles)) {
                        if (triangles.length === 0) {
                            computedFaces[direction] = { uv: [0, 0, 16, 16], texture: null, rotation: 0 };
                            continue;
                        }

                        triangles.sort((a, b) => b.area - a.area);
                        let bestUVs = [];
                        let bestTexture = null;
                        const maxTriangles = Math.min(triangles.length, 2);
                        for (let i = 0; i < maxTriangles; i++) {
                            bestUVs.push(...triangles[i].uvs);
                            if (!bestTexture) bestTexture = triangles[i].texture;
                        }

                        if (bestUVs.length >= 3) {
                            const uValues = bestUVs.map(point => point[0]);
                            const vValues = bestUVs.map(point => point[1]);
                            const minU = Math.min(...uValues);
                            const maxU = Math.max(...uValues);
                            const minV = Math.min(...vValues);
                            const maxV = Math.max(...vValues);

                            computedFaces[direction] = {
                                uv: (direction === 'up' || direction === 'down')
                                    ? [minU, minV, maxU, maxV]
                                    : [minU, maxV, maxU, minV],
                                texture: bestTexture,
                                rotation: 0
                            };
                        } else {
                            computedFaces[direction] = { uv: [0, 0, 16, 16], texture: bestTexture, rotation: 0 };
                        }
                    }

                    const cube = new Cube({
                        name: mesh.name,
                        color: mesh.color,
                        origin: mesh.origin ? mesh.origin.slice() : [0, 0, 0],
                        rotation: mesh.rotation ? mesh.rotation.slice() : [0, 0, 0],
                        box_uv: false,
                        autouv: 0,
                        from: [minX + mesh.origin[0], minY + mesh.origin[1], minZ + mesh.origin[2]],
                        to: [maxX + mesh.origin[0], maxY + mesh.origin[1], maxZ + mesh.origin[2]],
                        faces: {
                            north: { uv: computedFaces.north.uv, texture: computedFaces.north.texture, rotation: 0 },
                            south: { uv: computedFaces.south.uv, texture: computedFaces.south.texture, rotation: 0 },
                            east: { uv: computedFaces.east.uv, texture: computedFaces.east.texture, rotation: 0 },
                            west: { uv: computedFaces.west.uv, texture: computedFaces.west.texture, rotation: 0 },
                            up: { uv: computedFaces.up.uv, texture: computedFaces.up.texture, rotation: 0 },
                            down: { uv: computedFaces.down.uv, texture: computedFaces.down.texture, rotation: 0 }
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
