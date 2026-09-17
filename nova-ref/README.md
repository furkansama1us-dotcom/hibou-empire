# Références visuelles de Nova

Les 8 vues de la mascotte, envoyées telles quelles à Higgsfield
(`input_images` de `POST /nano-banana`) à chaque slide générée depuis
l'appli. C'est ce qui garantit que Nova reste identique d'une image à
l'autre sans passer par le Reference Element (réservé au MCP).

Fichiers attendus : `nova-1.png` à `nova-8.png`, carrés, fond blanc.
Servis publiquement par Vercel sur `/nova-ref/nova-N.png` — l'URL doit
rester accessible sans authentification, sinon Higgsfield ne peut pas les lire.

Pour changer de jeu de références sans toucher au code, définir la variable
d'environnement `NOVA_REFERENCE_IMAGES` (URLs séparées par des virgules).
