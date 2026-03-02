# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

VERB = @
ifeq (VERBOSE,1)
	VERB =
endif

PORT = 3000

# Install npm dependencies.
install:
	$(VERB) npm install

# Run the Vite dev server.
dev:
	$(VERB) npx vite --port $(PORT)

# Build for production (output in dist/).
build:
	$(VERB) npx vite build

# Preview the production build locally.
preview:
	$(VERB) npx vite preview --port $(PORT)
