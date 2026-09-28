/** Public project facts only. A missing version or change note means REZICS has not tracked a release. */
export interface SeedSoftware {
  id: string; title: string; pitch: string; project: string; source: string;
  maintainer: string; license: string; platforms: readonly string[];
  alternatives: readonly { id: string; reason: string }[];
}

export const softwareCatalogue: readonly SeedSoftware[] = [
  { id: 'app-firefox', title: 'Firefox', pitch: 'A web browser from Mozilla.', project: 'https://www.mozilla.org/firefox/',
    source: 'https://searchfox.org/mozilla-central/', maintainer: 'Mozilla', license: 'MPL-2.0',
    platforms: ['Linux', 'Windows', 'macOS'], alternatives: [{ id: 'app-chromium', reason: 'Another open-source browser engine and interface.' }] },
  { id: 'app-chromium', title: 'Chromium', pitch: 'The open-source browser project behind Chrome.',
    project: 'https://www.chromium.org/getting-involved/download-chromium/', source: 'https://chromium.googlesource.com/chromium/src/',
    maintainer: 'The Chromium Authors', license: 'Multiple open-source licenses', platforms: ['Linux', 'Windows', 'macOS'],
    alternatives: [{ id: 'app-firefox', reason: 'Uses a different browser engine.' }] },
  { id: 'app-gimp', title: 'GIMP', pitch: 'Edit and retouch raster images.', project: 'https://www.gimp.org/downloads/',
    source: 'https://gitlab.gnome.org/GNOME/gimp', maintainer: 'The GIMP Team', license: 'GPL-3.0-or-later',
    platforms: ['Linux', 'Windows', 'macOS'], alternatives: [{ id: 'app-krita', reason: 'Focuses on digital painting and illustration.' }] },
  { id: 'app-krita', title: 'Krita', pitch: 'Paint and illustrate with brushes and layers.',
    project: 'https://krita.org/en/download/', source: 'https://invent.kde.org/graphics/krita',
    maintainer: 'Krita Foundation', license: 'GPL-3.0-or-later', platforms: ['Linux', 'Windows', 'macOS'],
    alternatives: [{ id: 'app-gimp', reason: 'Focuses on photo editing and raster image work.' }] },
  { id: 'app-blender', title: 'Blender', pitch: 'Create 3D models, animation and rendered scenes.',
    project: 'https://www.blender.org/download/', source: 'https://projects.blender.org/blender/blender',
    maintainer: 'Blender Foundation', license: 'GPL-3.0-or-later', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
  { id: 'app-vlc', title: 'VLC media player', pitch: 'Play local video and audio in many formats.',
    project: 'https://www.videolan.org/vlc/', source: 'https://code.videolan.org/videolan/vlc',
    maintainer: 'VideoLAN', license: 'GPL-2.0-or-later', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
  { id: 'app-libreoffice', title: 'LibreOffice', pitch: 'Write documents, build spreadsheets and make presentations.',
    project: 'https://www.libreoffice.org/download/download-libreoffice/', source: 'https://git.libreoffice.org/core',
    maintainer: 'The Document Foundation', license: 'MPL-2.0', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
  { id: 'app-inkscape', title: 'Inkscape', pitch: 'Draw and edit vector graphics.',
    project: 'https://inkscape.org/release/', source: 'https://gitlab.com/inkscape/inkscape',
    maintainer: 'Inkscape contributors', license: 'GPL-2.0-or-later', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
  { id: 'app-obs', title: 'OBS Studio', pitch: 'Record screens and produce live video.',
    project: 'https://obsproject.com/download', source: 'https://github.com/obsproject/obs-studio',
    maintainer: 'OBS Project', license: 'GPL-2.0-or-later', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
  { id: 'app-kdenlive', title: 'Kdenlive', pitch: 'Edit video on a multitrack timeline.',
    project: 'https://kdenlive.org/download/', source: 'https://invent.kde.org/multimedia/kdenlive',
    maintainer: 'KDE', license: 'GPL-3.0-or-later', platforms: ['Linux', 'Windows', 'macOS'], alternatives: [] },
];
